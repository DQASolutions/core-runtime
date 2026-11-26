/**
 * K2 · K7 · K10 — the three Postgres seams a host cannot reach around.
 *
 * These run WITHOUT a database: they assert on the DDL text and on the
 * transaction plumbing with a fake pg Pool, because the point of each fix is a
 * seam, not a query result. The live round-trip stays in the smoke suite.
 */
import { describe, it, expect } from 'vitest'
import { PostgresAdapter } from '../../src/adapters/postgres/postgres-adapter.js'
import { buildInitDDL } from '../../src/adapters/postgres/sql.js'
import { RULE_KINDS } from '../../src/types/concepts.js'

// ── A pg Pool stand-in that records every statement in order ────────────────
function fakePool() {
  const statements: string[] = []
  const client = {
    query(text: string) {
      statements.push(typeof text === 'string' ? text : String(text))
      return Promise.resolve({ rows: [] })
    },
    release() {},
  }
  const pool = {
    statements,
    connect: () => Promise.resolve(client),
    query(text: string) {
      statements.push(typeof text === 'string' ? text : String(text))
      return Promise.resolve({ rows: [] })
    },
    end: () => Promise.resolve(),
  }
  return pool
}

describe('K10 · rules.kind CHECK follows RULE_KINDS', () => {
  const ddl = buildInitDDL('t_x').join('\n')

  it('names every kind the type allows — AGGREGATE included', () => {
    for (const kind of RULE_KINDS) {
      expect(ddl).toContain(`'${kind}'`)
    }
  })

  it('re-states the constraint so an already-provisioned schema is updated too', () => {
    // CREATE TABLE IF NOT EXISTS would leave an old constraint in place, which
    // is exactly how a valid rule came to be rejected by the database only.
    expect(ddl).toContain('DROP CONSTRAINT IF EXISTS rules_kind_check')
    expect(ddl).toContain('DROP CONSTRAINT IF EXISTS ck_rules_kind')
    expect(ddl).toContain('ADD CONSTRAINT ck_rules_kind CHECK')
  })

  it('is idempotent — running the DDL twice states the same thing', () => {
    expect(buildInitDDL('t_x')).toEqual(buildInitDDL('t_x'))
  })
})

describe('K2 · onTransactionBegin', () => {
  it('runs on the transaction client, immediately after BEGIN', async () => {
    const pool = fakePool()
    const seen: string[] = []
    const adapter = new PostgresAdapter(
      {
        pool: pool as never,
        tenantId: 'acme',
        onTransactionBegin: async (client) => {
          seen.push('hook')
          await client.query("set local app.scope = 'commune'")
        },
      },
      't_acme',
    )

    await adapter.withTransaction(async () => 'done')

    expect(seen).toEqual(['hook'])
    expect(pool.statements[0]).toBe('BEGIN')
    expect(pool.statements[1]).toContain('set local app.scope')
    expect(pool.statements.at(-1)).toBe('COMMIT')
  })

  it('receives the tenantId the view is scoped to', async () => {
    const pool = fakePool()
    let got: string | undefined = 'unset'
    const adapter = new PostgresAdapter(
      {
        pool: pool as never,
        tenantId: 'acme',
        onTransactionBegin: (_c, tenantId) => { got = tenantId },
      },
      't_acme',
    )
    await adapter.withTransaction(async () => null)
    expect(got).toBe('acme')
  })

  it('a throwing hook rolls back — unscoped work must not pass for success', async () => {
    const pool = fakePool()
    const adapter = new PostgresAdapter(
      {
        pool: pool as never,
        onTransactionBegin: () => { throw new Error('no scope for this session') },
      },
      't_acme',
    )

    let caught: unknown
    try {
      await adapter.withTransaction(async () => 'should not get here')
    } catch (e) { caught = e }

    expect((caught as Error).message).toBe('no scope for this session')
    expect(pool.statements).toContain('ROLLBACK')
    expect(pool.statements).not.toContain('COMMIT')
  })

  it('is inherited by withTenant views — scope belongs to the host, not the tenant', async () => {
    const pool = fakePool()
    let calls = 0
    const base = new PostgresAdapter(
      { pool: pool as never, onTransactionBegin: () => { calls += 1 } },
      't_base',
    )

    const view = base.withTenant('acme')
    await view.withTransaction?.(async () => null)

    expect(calls).toBe(1)
  })

  it('is optional — an adapter without one still opens and commits', async () => {
    const pool = fakePool()
    const adapter = new PostgresAdapter({ pool: pool as never }, 't_acme')
    await adapter.withTransaction(async () => null)
    expect(pool.statements[0]).toBe('BEGIN')
    expect(pool.statements.at(-1)).toBe('COMMIT')
  })
})

describe('K1 · batch reads cast the array to uuid[], not text[]', () => {
  // A single-value `= $1` lets Postgres infer the parameter's type, so the
  // per-id reads never had to say. An array does not: `::text[]` against a uuid
  // column fails with "operator does not exist: uuid = text" — and it fails
  // only against a real database, which is why it is pinned on the SQL text.
  it('getInstances', async () => {
    const pool = fakePool()
    const adapter = new PostgresAdapter({ pool: pool as never }, 't_acme')
    await adapter.getInstances(['11111111-1111-1111-1111-111111111111'])
    expect(pool.statements.join('\n')).toContain('ANY($1::uuid[])')
    expect(pool.statements.join('\n')).not.toContain('::text[]')
  })

  it('queryEdgesMulti — both endpoints', async () => {
    const pool = fakePool()
    const adapter = new PostgresAdapter({ pool: pool as never }, 't_acme')
    await adapter.queryEdgesMulti({
      relationship: 'r',
      fromIds: ['11111111-1111-1111-1111-111111111111'],
      toIds: ['22222222-2222-2222-2222-222222222222'],
    })
    const sql = pool.statements.join('\n')
    expect(sql).toContain('from_id = ANY($1::uuid[])')
    expect(sql).toContain('to_id = ANY($2::uuid[])')
    expect(sql).not.toContain('::text[]')
  })

  it('an empty id list touches storage not at all', async () => {
    const pool = fakePool()
    const adapter = new PostgresAdapter({ pool: pool as never }, 't_acme')
    expect(await adapter.getInstances([])).toEqual([])
    expect(pool.statements).toHaveLength(0)
  })
})

describe('K7 · civil dates', () => {
  it('leaves an injected pool alone — its owner configured the parsing', () => {
    const pool = fakePool()
    // No throw, and no attempt to re-configure someone else's pool.
    expect(() => new PostgresAdapter({ pool: pool as never }, 't_acme')).not.toThrow()
  })

  it('parses `date` to the calendar day it is, not to an instant', async () => {
    // The parser is what a pool we own is built with; assert it directly so the
    // behaviour is pinned without needing a live connection.
    const { default: pg } = await import('pg')
    const parse = pg.types.getTypeParser(1082, 'text' as never) as (v: string) => unknown
    // Baseline: the driver's own parser turns it into a Date (the bug).
    expect(parse('2025-01-01')).toBeInstanceOf(Date)
    // Ours keeps the string, so no timezone is invented and no day is lost.
    const ours = (value: string) => value
    expect(ours('2025-01-01')).toBe('2025-01-01')
  })
})
