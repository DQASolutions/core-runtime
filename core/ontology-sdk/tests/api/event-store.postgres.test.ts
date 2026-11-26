/**
 * M2b — real Postgres atomicity. Verifies PostgresAdapter.withTransaction +
 * PostgresEventStore enlist on the SAME pg client, so an event commits iff state
 * commits (and a failed append rolls the state mutation back for real).
 *
 * Gated: only runs with a live Postgres (TEST_ADAPTER=postgres or DATABASE_URL).
 * Skipped otherwise, so `npm test` (memory) is unaffected.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import pg from 'pg'
import {
  createOntology,
  PostgresAdapter,
  PostgresEventStore,
  type EventStore,
  type Ontology,
  type OntologyEvent,
  type UnitOfWork,
} from '../../src/index.js'

const RUN = process.env['TEST_ADAPTER'] === 'postgres' || !!process.env['DATABASE_URL']
const CONN = process.env['DATABASE_URL'] ?? 'postgres://ontology:ontology@localhost:5433/ontology'

const prov = { source_ref: 'src', confirmed_by: 'u', confirmed_at: '2026-01-01T00:00:00.000Z' }
const tenant = `m2b_${Date.now()}`
const ctx = { tenantId: tenant }

let pool: pg.Pool
let events: PostgresEventStore
let ont: Ontology

describe.runIf(RUN)('PostgresEventStore — atomic with state (M2b)', () => {
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: CONN })
    events = new PostgresEventStore({ pool })
    ont = createOntology({ adapter: new PostgresAdapter({ pool }), eventStore: events })
    await ont.defineEntityType({ name: 'doc', label: 'Doc', properties: [] }, ctx)
    await ont.migrate(ctx) // provisions instances + events tables in the tenant schema
  })

  afterAll(async () => {
    try {
      await new PostgresAdapter({ pool }).withTenant(tenant).clearTenant()
    } finally {
      await pool.end()
    }
  })

  it('appends the event in the same transaction as the state write', async () => {
    const e = (await ont.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx))[0]!
    const log = await events.read(tenant, e.aggregate)
    expect(log).toHaveLength(1)
    expect(log[0]!.type).toBe('instance.created')
    expect(log[0]!.version).toBe(1)
    // state is really there too
    expect(await ont.find('doc', undefined, ctx)).toHaveLength(1)
  })

  it('is the version authority — per-aggregate version increments', async () => {
    const c = (await ont.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx))[0]!
    await ont.applyAction('updateInstance', { id: c.aggregate, patch: {} }, prov, ctx)
    const log = await events.read(tenant, c.aggregate)
    expect(log.map((x) => x.version)).toEqual([1, 2])
  })

  it('verify() detects tampering in the events table', async () => {
    const e = (await ont.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx))[0]!
    expect((await events.verify(tenant)).ok).toBe(true)
    // tamper: edit a stored payload directly, leaving the stored hash stale
    const schema = `t_${tenant}`
    await pool.query(`UPDATE "${schema}".events SET payload = '{"tampered":true}'::jsonb WHERE id = $1`, [e.id])
    const v = await events.verify(tenant)
    expect(v.ok).toBe(false)
    expect(typeof v.brokenAt).toBe('number')
  })

  it('ROLLS BACK the state write for real when the append fails', async () => {
    // an EventStore that throws inside the tx → withTransaction must ROLLBACK
    const boom: EventStore = {
      async append(_e: OntologyEvent[], _uow: UnitOfWork) {
        throw new Error('event store down')
      },
      async read() {
        return []
      },
      async scan() {
        return []
      },
    }
    const o = createOntology({ adapter: new PostgresAdapter({ pool }), eventStore: boom })
    await o.defineEntityType({ name: 'doc', label: 'Doc', properties: [] }, ctx)

    const before = (await o.find('doc', undefined, ctx)).length
    await expect(
      o.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx),
    ).rejects.toThrow('event store down')
    const after = (await o.find('doc', undefined, ctx)).length
    expect(after).toBe(before) // no orphaned instance — real ROLLBACK
  })
})
