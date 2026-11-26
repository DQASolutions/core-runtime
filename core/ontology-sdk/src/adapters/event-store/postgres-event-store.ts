// PostgresEventStore — the durable system-of-record change log on Postgres, one
// `events` table per tenant schema (data lives beside the graph; see ADR — event
// store). The store is the version authority (per-aggregate, fixes the v1 stamp)
// and assigns a tenant-global `seq` (bigserial) for ordered replay.
//
// Atomicity: when the write-door ran inside PostgresAdapter.withTransaction, the
// pg client arrives on `uow.raw` and append enlists in THAT transaction → event
// commits iff state commits (M2b). Until withTransaction lands, `uow.raw` is
// absent and append runs best-effort on the pool (M2a).

import type pg from 'pg'

import type { EventStore } from '../../ports/event-store.js'
import type { UnitOfWork } from '../../ports/storage-adapter.js'
import type { OntologyEvent, Value } from '../../types/index.js'
import { assertSafeIdentifier, toSchemaName } from '../postgres/sql.js'
import { type ChainVerdict, GENESIS, hashEvent } from './hash-chain.js'
import { loadDriver } from '../load-driver.js'

interface EventRow {
  id: string
  aggregate_id: string
  version: number
  type: string
  payload: unknown
  actor: string
  ts: Date | string
  action?: string | null
  prev_hash?: string
  hash?: string
}

/** A pg client/pool exposes `.query`; used to detect an enlistable tx handle. */
function asQueryable(raw: unknown): { query: pg.Pool['query'] } | null {
  return raw && typeof (raw as { query?: unknown }).query === 'function'
    ? (raw as { query: pg.Pool['query'] })
    : null
}

function rowToEvent(r: EventRow): OntologyEvent {
  return {
    id: r.id,
    ts: r.ts instanceof Date ? r.ts.toISOString() : r.ts,
    type: r.type,
    aggregate: r.aggregate_id,
    payload: (r.payload as Value) ?? null,
    actor: r.actor,
    version: r.version,
    // `?? undefined` chứ không `?? null`: kho dựng trước bản có cột này trả về
    // NULL, và một trường tuỳ chọn mang `null` khác hẳn một trường vắng mặt khi
    // đem so chuỗi băm.
    ...(r.action ? { action: r.action } : {}),
  }
}

export class PostgresEventStore implements EventStore {
  private readonly pool: pg.Pool

  constructor(opts: { connectionString?: string; pool?: pg.Pool } = {}) {
    this.pool =
      opts.pool ??
      new (loadDriver<typeof pg>('pg', 'PostgresEventStore').Pool)({
        connectionString:
          opts.connectionString ??
          process.env['DATABASE_URL'] ??
          'postgres://ontology:ontology@localhost:5433/ontology',
      })
  }

  async append(events: OntologyEvent[], uow: UnitOfWork): Promise<void> {
    if (events.length === 0) return
    const schema = toSchemaName(uow.tenantId)
    assertSafeIdentifier(schema, 'EventStore.append')
    // Enlist in the state transaction when the adapter handed us its pg client;
    // otherwise best-effort on the pool.
    const exec = asQueryable(uow.raw) ?? this.pool
    // Chain head = the last event's hash by stream order (sees this tx's writes).
    const head = await exec.query<{ hash: string }>(
      `SELECT hash FROM "${schema}".events ORDER BY seq DESC LIMIT 1`,
    )
    let prev = head.rows[0]?.hash ?? GENESIS
    for (const e of events) {
      // Version + hash computed here (not in SQL) so the chain covers the version.
      const vres = await exec.query<{ v: number }>(
        `SELECT coalesce(max(version), 0) + 1 AS v FROM "${schema}".events WHERE aggregate_id = $1`,
        [e.aggregate],
      )
      const version = Number(vres.rows[0]!.v)
      const stored: OntologyEvent = { ...e, version }
      const hash = hashEvent(prev, stored)
      await exec.query(
        `INSERT INTO "${schema}".events (id, aggregate_id, version, type, payload, actor, ts, prev_hash, hash, action)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`,
        [e.id, e.aggregate, version, e.type, JSON.stringify(e.payload ?? null), e.actor, e.ts, prev, hash, e.action ?? null],
      )
      prev = hash
    }
  }

  async read(tenantId: string, aggregateId: string): Promise<OntologyEvent[]> {
    const schema = toSchemaName(tenantId)
    assertSafeIdentifier(schema, 'EventStore.read')
    const res = await this.pool.query<EventRow>(
      `SELECT id, aggregate_id, version, type, payload, actor, ts, action
         FROM "${schema}".events WHERE aggregate_id = $1 ORDER BY version ASC`,
      [aggregateId],
    )
    return res.rows.map(rowToEvent)
  }

  async scan(tenantId: string, fromSeq = 0): Promise<OntologyEvent[]> {
    const schema = toSchemaName(tenantId)
    assertSafeIdentifier(schema, 'EventStore.scan')
    const res = await this.pool.query<EventRow>(
      `SELECT id, aggregate_id, version, type, payload, actor, ts, action
         FROM "${schema}".events WHERE seq > $1 ORDER BY seq ASC`,
      [fromSeq],
    )
    return res.rows.map(rowToEvent)
  }

  async verify(tenantId: string): Promise<ChainVerdict> {
    const schema = toSchemaName(tenantId)
    assertSafeIdentifier(schema, 'EventStore.verify')
    const res = await this.pool.query<EventRow>(
      `SELECT id, aggregate_id, version, type, payload, actor, ts, action, prev_hash, hash
         FROM "${schema}".events ORDER BY seq ASC`,
    )
    let prev = GENESIS
    for (let i = 0; i < res.rows.length; i++) {
      const r = res.rows[i]!
      const e = rowToEvent(r)
      if (r.prev_hash !== prev || hashEvent(prev, e) !== r.hash) {
        return { ok: false, count: res.rows.length, brokenAt: i }
      }
      prev = r.hash!
    }
    return { ok: true, count: res.rows.length }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}
