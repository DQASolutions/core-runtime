// Layer 1 — PostgresAdapter. The ONLY layer allowed to import pg.
// Implements StorageAdapter via a node-postgres Pool with schema-per-tenant
// isolation (data-model §3, ADR-0005). Every value reaches the DB as a $n
// parameter — no string interpolation of user-supplied values (C-004 / ADR-0003).

import { randomUUID } from 'node:crypto'
import type pg from 'pg'

import type {
  ConditionExpr,
  Edge,
  Instance,
  MigrationReport,
  OntologySchema,
  Provenance,
  RuleDef,
} from '../../types/index.js'
import type {
  EdgeQuery,
  MultiEdgeQuery,
  Row,
  StorageAdapter,
  UnitOfWork,
} from '../../ports/storage-adapter.js'
import { ontologyError } from '../../types/index.js'
import { matchesProperties } from '../../shared/condition-match.js'
import { assertSafeIdentifier, buildInitDDL } from './sql.js'
import { loadDriver } from '../load-driver.js'
import { compilePropertyFilter } from './condition-sql.js'

/** node-postgres, loaded when a pool is first built (optional peer). */
const loadPg = (): typeof pg => loadDriver<typeof pg>('pg', 'PostgresAdapter')

/** OID of Postgres `date`. */
const DATE_OID = 1082

/**
 * Type parsing for pools this adapter creates: `date` comes back as the civil
 * date string it is, not as an instant.
 *
 * Why: node-postgres turns a `date` column into a Date at midnight in the
 * SERVER's timezone. On a machine running UTC+7, `2025-01-01` becomes
 * `2024-12-31T17:00:00Z`, and the usual `toISOString().slice(0,10)` then prints
 * **31/12/2024** — the record's date, off by one, silently, and only outside
 * UTC. A `date` in a record is a calendar day (signed on, examined on, due on),
 * not a point in time; the driver's coercion invents a timezone that was never
 * in the data.
 *
 * Scoped to pools we own. When the host injects its own Pool it owns parsing —
 * see `civilDates` in PostgresAdapterOptions.
 */
const civilDateTypes = {
  getTypeParser(oid: number, format?: unknown): unknown {
    if (oid === DATE_OID) return (value: string) => value
    return (loadPg().types.getTypeParser as (o: number, f?: unknown) => unknown)(oid, format)
  },
}

// ── Public options type ───────────────────────────────────────────────────────

export interface PostgresAdapterOptions {
  connectionString?: string
  pool?: pg.Pool
  /** When set, this adapter view runs every query on this checked-out client —
   *  i.e. inside an open transaction (set by withTransaction). */
  client?: pg.PoolClient
  /** The tenantId this view is scoped to (carried so withTransaction can name it
   *  in the UnitOfWork; the schema is derived from it). */
  tenantId?: string
  /**
   * Called on the transaction's client immediately after BEGIN, before any of
   * the caller's work runs — the seam for per-transaction session state the
   * host needs on the WRITE path, most obviously `SET LOCAL` for row-level
   * security.
   *
   * Why the kernel must offer this: withTransaction() checks out its own client
   * and BEGINs, so a host has no moment to speak to that connection. Without a
   * hook the only way to get `SET LOCAL` onto every write transaction is to
   * wrap the whole Pool and intercept `query`, which every host would then
   * reinvent — and row-level scoping is too load-bearing to leave to a wrapper
   * each host writes itself.
   *
   * Runs INSIDE the transaction: throwing here rolls back and surfaces, so a
   * failure to apply scope can never be mistaken for an unscoped success.
   * Inherited by withTenant() views, since scope is a property of the host, not
   * of the tenant.
   */
  onTransactionBegin?: (client: pg.PoolClient, tenantId: string | undefined) => Promise<void> | void
  /**
   * Return `date` columns as the `YYYY-MM-DD` string they are, instead of a
   * Date at midnight server-time. Default **true** — the coercion is a
   * timezone-dependent off-by-one on any host not running UTC.
   *
   * Only applies to pools this adapter creates; an injected `pool` keeps
   * whatever parsing its owner configured. Set false to restore the old
   * behaviour.
   */
  civilDates?: boolean
}

// ── Internal DB row shapes (snake_case) ───────────────────────────────────────

interface InstanceRow {
  id: string
  entity_type: string
  data: unknown
  source_ref: string
  confirmed_by: string
  confirmed_at: Date | string
  created_at?: Date | string
  updated_at?: Date | string
}

interface EdgeRow {
  id: string
  rel: string
  from_id: string
  to_id: string
  source_ref: string
  confirmed_by: string
  confirmed_at: Date | string
  created_at?: Date | string
}

interface RuleRow {
  id: string
  name: string
  kind: string
  applies_to: string
  condition: unknown
  severity: string
  message: string
  enabled: boolean
  version: number
  source_ref: string
  confirmed_by: string
  confirmed_at: Date | string
}

// ── ISO string helper ─────────────────────────────────────────────────────────

function toIso(v: Date | string | undefined): string {
  if (v === undefined) return new Date().toISOString()
  if (v instanceof Date) return v.toISOString()
  return v
}

// ── Row → domain mappers ──────────────────────────────────────────────────────

function rowToInstance(row: InstanceRow): Instance {
  const confirmedAt = toIso(row.confirmed_at)
  return {
    id: row.id,
    entityType: row.entity_type,
    data: (row.data as Record<string, unknown>) ?? {},
    provenance: { source_ref: row.source_ref, confirmed_by: row.confirmed_by, confirmed_at: confirmedAt },
    source_ref: row.source_ref,
    confirmed_by: row.confirmed_by,
    confirmed_at: confirmedAt,
  }
}

function rowToEdge(row: EdgeRow): Edge {
  const confirmedAt = toIso(row.confirmed_at)
  return {
    id: row.id,
    relationship: row.rel,
    fromId: row.from_id,
    toId: row.to_id,
    provenance: { source_ref: row.source_ref, confirmed_by: row.confirmed_by, confirmed_at: confirmedAt },
    source_ref: row.source_ref,
    confirmed_by: row.confirmed_by,
    confirmed_at: confirmedAt,
  }
}

function rowToRule(row: RuleRow): RuleDef {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as RuleDef['kind'],
    appliesTo: row.applies_to,
    condition: row.condition as ConditionExpr,
    severity: row.severity,
    message: row.message,
    enabled: row.enabled,
    version: row.version,
    source_ref: row.source_ref,
    confirmed_by: row.confirmed_by,
    confirmed_at: toIso(row.confirmed_at),
  }
}

// ── Tenant schema name sanitizer ─────────────────────────────────────────────

/**
 * Derive a safe Postgres schema identifier from a tenantId.
 * Prefix `t_` ensures the result never begins with a digit; replaces any
 * character outside [a-zA-Z0-9_] with `_`.
 */
function toSchemaName(tenantId: string): string {
  const sanitized = tenantId.replace(/[^a-zA-Z0-9_]/g, '_')
  return `t_${sanitized}`
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class PostgresAdapter implements StorageAdapter {
  protected readonly pool: pg.Pool
  /** Postgres schema this adapter instance is scoped to. */
  protected readonly schema: string
  /** When set, all queries run on this client = inside an open transaction. */
  protected readonly client?: pg.PoolClient
  /** The tenantId backing `schema` (for the UnitOfWork name). */
  protected readonly tenantId?: string
  /** Host hook run just after BEGIN — see PostgresAdapterOptions. */
  protected readonly onTransactionBegin?: PostgresAdapterOptions['onTransactionBegin']

  constructor(opts: PostgresAdapterOptions = {}, schema = 't___default__') {
    if (opts.pool !== undefined) {
      this.pool = opts.pool
    } else {
      const connStr =
        opts.connectionString ??
        process.env['DATABASE_URL'] ??
        'postgres://ontology:ontology@localhost:5433/ontology'
      this.pool = new (loadPg().Pool)({
        connectionString: connStr,
        ...(opts.civilDates === false ? {} : { types: civilDateTypes }),
      })
    }
    this.schema = schema
    if (opts.client !== undefined) this.client = opts.client
    if (opts.tenantId !== undefined) this.tenantId = opts.tenantId
    if (opts.onTransactionBegin !== undefined) this.onTransactionBegin = opts.onTransactionBegin
  }

  /** Run statements on the open transaction client when inside one, else the pool. */
  protected get exec(): pg.Pool | pg.PoolClient {
    return this.client ?? this.pool
  }

  // ── Tenancy ─────────────────────────────────────────────────────────────────

  withTenant(tenantId: string): StorageAdapter {
    const schemaName = toSchemaName(tenantId)
    assertSafeIdentifier(schemaName, 'withTenant')
    // The hook is carried across: row-level scope is a property of the HOST, so
    // a tenant view that quietly dropped it would write unscoped and look fine.
    return this.spawn(
      {
        pool: this.pool,
        tenantId,
        ...(this.onTransactionBegin !== undefined
          ? { onTransactionBegin: this.onTransactionBegin }
          : {}),
      },
      schemaName,
    )
  }

  /**
   * The ONE place a derived view of this adapter is constructed. withTenant and
   * withTransaction both go through it, so a subclass overrides this alone and
   * its tenant views and transaction views stay its own type — rather than
   * silently degrading to a plain PostgresAdapter mid-transaction, which is the
   * kind of bug that only shows up on the write path under load.
   */
  protected spawn(opts: PostgresAdapterOptions, schemaName: string): StorageAdapter {
    return new PostgresAdapter(opts, schemaName)
  }

  /**
   * Every DDL statement applySchema runs — the ONE place the physical shape is
   * decided. A subclass storing rows some other way overrides this and inherits
   * the rest of applySchema (metadata upserts, transaction, report) unchanged.
   *
   * Split out because the alternative is a subclass reimplementing applySchema,
   * which then has to keep the metadata upserts in step by hand — and the day
   * they drift is the day entity_types stops describing what is really stored.
   */
  protected schemaDDL(_schema: OntologySchema): string[] {
    return buildInitDDL(this.schema)
  }

  // ── Transaction (M2b) — atomic unit of work ──────────────────────────────────
  // Check out one client, BEGIN, run `fn` against a client-scoped adapter view so
  // every state write lands on the same transaction; hand the client out on
  // `uow.raw` so a co-located EventStore appends in the SAME tx → event commits
  // iff state commits. COMMIT on success, ROLLBACK on any throw.
  async withTransaction<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // Host's seam — SET LOCAL for row-level security and the like. Inside the
      // transaction on purpose: a throw here rolls back, so failing to apply
      // scope can never pass for an unscoped success.
      await this.onTransactionBegin?.(client, this.tenantId)
      const tx = this.spawn(
        {
          pool: this.pool,
          client,
          ...(this.tenantId !== undefined ? { tenantId: this.tenantId } : {}),
          ...(this.onTransactionBegin !== undefined
            ? { onTransactionBegin: this.onTransactionBegin }
            : {}),
        },
        this.schema,
      )
      const result = await fn({ tenantId: this.tenantId ?? '', adapter: tx, raw: client })
      await client.query('COMMIT')
      return result
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* ignore rollback failure; surface the original error */
      }
      throw err
    } finally {
      client.release()
    }
  }

  /** Dispose the connection pool. Shared across all withTenant() views, so call
   *  once at app shutdown — afterwards the process can exit cleanly. */
  async close(): Promise<void> {
    await this.pool.end()
  }

  // Drop the tenant's entire schema (all tables: instances, edges, rules,
  // entity_types, …). The next applySchema re-provisions it from scratch.
  async clearTenant(): Promise<void> {
    assertSafeIdentifier(this.schema, 'clearTenant')
    await this.exec.query(`DROP SCHEMA IF EXISTS "${this.schema}" CASCADE`)
  }

  // ── Schema provisioning ──────────────────────────────────────────────────────

  async applySchema(schema: OntologySchema): Promise<MigrationReport> {
    assertSafeIdentifier(this.schema, 'applySchema')
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      // 1. Create extension + schema + all tables + indexes
      for (const ddl of this.schemaDDL(schema)) {
        await client.query(ddl)
      }

      const applied: string[] = ['0001_init_ontology']

      // 2. Upsert entity_types rows
      for (const et of schema.entityTypes) {
        // Use a synthetic provenance for schema rows — callers don't supply prov
        // for schema calls, so we use a well-known sentinel.
        const prov: Provenance = {
          source_ref: 'applySchema',
          confirmed_by: 'system',
          confirmed_at: new Date().toISOString(),
        }
        await client.query(
          `INSERT INTO "${this.schema}".entity_types (id, name, label, source_ref, confirmed_by, confirmed_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (name) DO UPDATE
             SET label        = EXCLUDED.label,
                 source_ref   = EXCLUDED.source_ref,
                 confirmed_by = EXCLUDED.confirmed_by,
                 confirmed_at = EXCLUDED.confirmed_at`,
          [
            randomUUID(),
            et.name,
            et.label,
            prov.source_ref,
            prov.confirmed_by,
            prov.confirmed_at,
          ],
        )

        // Fetch the canonical entity_type row id for FK on property_defs
        const etRes = await client.query<{ id: string }>(
          `SELECT id FROM "${this.schema}".entity_types WHERE name = $1`,
          [et.name],
        )
        const etRow = etRes.rows[0]
        if (etRow === undefined) {
          throw ontologyError('MIGRATION_FAILED', `entity_type "${et.name}" not found after upsert`)
        }
        const entityTypeId = etRow.id

        // Upsert property_defs
        for (const pd of et.properties) {
          await client.query(
            `INSERT INTO "${this.schema}".property_defs
               (id, entity_type_id, name, type, enum_values, catalogue, required, description)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (entity_type_id, name) DO UPDATE
               SET type        = EXCLUDED.type,
                   enum_values = EXCLUDED.enum_values,
                   catalogue   = EXCLUDED.catalogue,
                   required    = EXCLUDED.required,
                   description = EXCLUDED.description`,
            [
              randomUUID(),
              entityTypeId,
              pd.name,
              pd.type,
              pd.enumValues !== undefined ? JSON.stringify(pd.enumValues) : null,
              pd.catalogue ?? null,
              pd.required ?? false,
              pd.description ?? null,
            ],
          )
        }
      }

      // 3. Upsert relationship_types rows
      for (const rt of schema.relationshipTypes) {
        const prov: Provenance = {
          source_ref: 'applySchema',
          confirmed_by: 'system',
          confirmed_at: new Date().toISOString(),
        }
        await client.query(
          `INSERT INTO "${this.schema}".relationship_types
             (id, name, from_type, to_type, cardinality, directed, description,
              source_ref, confirmed_by, confirmed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (name) DO UPDATE
             SET from_type    = EXCLUDED.from_type,
                 to_type      = EXCLUDED.to_type,
                 cardinality  = EXCLUDED.cardinality,
                 directed     = EXCLUDED.directed,
                 description  = EXCLUDED.description,
                 source_ref   = EXCLUDED.source_ref,
                 confirmed_by = EXCLUDED.confirmed_by,
                 confirmed_at = EXCLUDED.confirmed_at`,
          [
            randomUUID(),
            rt.name,
            rt.from,
            rt.to,
            rt.cardinality,
            rt.directed,
            rt.description ?? null,
            prov.source_ref,
            prov.confirmed_by,
            prov.confirmed_at,
          ],
        )
      }

      await client.query('COMMIT')

      void applied // migration ids tracked internally; not surfaced in MigrationReport
      return {
        appliedAt: new Date().toISOString(),
        changes: [
          ...schema.entityTypes.map((e) => ({
            type: 'EntityType' as const,
            name: e.name,
            op: 'created' as const,
          })),
          ...schema.relationshipTypes.map((r) => ({
            type: 'RelationshipType' as const,
            name: r.name,
            op: 'created' as const,
          })),
        ],
        errors: [],
      }
    } catch (err) {
      await client.query('ROLLBACK')
      throw ontologyError(
        'MIGRATION_FAILED',
        `applySchema failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: String(err) },
      )
    } finally {
      client.release()
    }
  }

  // ── Instances ────────────────────────────────────────────────────────────────

  async insertInstance(type: string, data: Row, prov: Provenance): Promise<Instance> {
    assertSafeIdentifier(this.schema, 'insertInstance')
    const id = randomUUID()
    const now = new Date().toISOString()
    await this.exec.query(
      `INSERT INTO "${this.schema}".instances
         (id, entity_type, data, source_ref, confirmed_by, confirmed_at, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)`,
      [id, type, JSON.stringify(data), prov.source_ref, prov.confirmed_by, prov.confirmed_at, now, now],
    )
    return {
      id,
      entityType: type,
      data: { ...data },
      provenance: { source_ref: prov.source_ref, confirmed_by: prov.confirmed_by, confirmed_at: prov.confirmed_at },
      source_ref: prov.source_ref,
      confirmed_by: prov.confirmed_by,
      confirmed_at: prov.confirmed_at,
    }
  }

  // Create-or-replace at a caller-supplied (deterministic) id. INSERT … ON
  // CONFLICT (id) DO UPDATE overwrites data + provenance, so an ingest re-run
  // with the same ref updates the same row instead of duplicating it.
  async upsertInstance(id: string, type: string, data: Row, prov: Provenance): Promise<Instance> {
    assertSafeIdentifier(this.schema, 'upsertInstance')
    const now = new Date().toISOString()
    await this.exec.query(
      `INSERT INTO "${this.schema}".instances
         (id, entity_type, data, source_ref, confirmed_by, confirmed_at, created_at, updated_at)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
       ON CONFLICT (id) DO UPDATE
         SET entity_type = EXCLUDED.entity_type,
             data         = EXCLUDED.data,
             source_ref   = EXCLUDED.source_ref,
             confirmed_by = EXCLUDED.confirmed_by,
             confirmed_at = EXCLUDED.confirmed_at,
             updated_at   = EXCLUDED.updated_at`,
      [id, type, JSON.stringify(data), prov.source_ref, prov.confirmed_by, prov.confirmed_at, now, now],
    )
    return {
      id,
      entityType: type,
      data: { ...data },
      provenance: { source_ref: prov.source_ref, confirmed_by: prov.confirmed_by, confirmed_at: prov.confirmed_at },
      source_ref: prov.source_ref,
      confirmed_by: prov.confirmed_by,
      confirmed_at: prov.confirmed_at,
    }
  }

  /**
   * So-rồi-đặt trong MỘT câu lệnh — điều kiện nằm ở `WHERE`, nên không có khe
   * nào giữa lúc so và lúc ghi, kể cả khi hai tiến trình cùng gọi.
   *
   * `data @> $expected` là phép chứa của jsonb: khớp khi mọi khoá trong
   * `expected` đang giữ đúng giá trị ấy. Khoá vắng mặt thì không khớp, nên bên
   * gọi muốn "đang là null" phải ghi rõ `null` — và jsonb null khớp với nó.
   */
  async compareAndSetInstance(id: string, expected: Row, patch: Row, prov: Provenance): Promise<boolean> {
    assertSafeIdentifier(this.schema, 'compareAndSetInstance')
    const res = await this.exec.query(
      `UPDATE "${this.schema}".instances
          SET data         = data || $2::jsonb,
              source_ref   = $3,
              confirmed_by = $4,
              confirmed_at = $5,
              updated_at   = $6
        WHERE id = $1
          AND data @> $7::jsonb`,
      [id, JSON.stringify(patch), prov.source_ref, prov.confirmed_by, prov.confirmed_at,
       new Date().toISOString(), JSON.stringify(expected)],
    )
    return (res.rowCount ?? 0) > 0
  }

  async updateInstance(id: string, patch: Row, prov: Provenance): Promise<Instance> {
    assertSafeIdentifier(this.schema, 'updateInstance')
    const selectRes = await this.exec.query<InstanceRow>(
      `SELECT id, entity_type, data, source_ref, confirmed_by, confirmed_at
         FROM "${this.schema}".instances WHERE id = $1`,
      [id],
    )
    const existing = selectRes.rows[0]
    if (existing === undefined) {
      throw ontologyError('INSTANCE_NOT_FOUND', `Instance "${id}" not found`)
    }
    const mergedData = { ...(existing.data as Record<string, unknown>), ...patch }
    const now = new Date().toISOString()
    await this.exec.query(
      `UPDATE "${this.schema}".instances
         SET data         = $1::jsonb,
             source_ref   = $2,
             confirmed_by = $3,
             confirmed_at = $4,
             updated_at   = $5
       WHERE id = $6`,
      [
        JSON.stringify(mergedData),
        prov.source_ref,
        prov.confirmed_by,
        prov.confirmed_at,
        now,
        id,
      ],
    )
    return {
      id,
      entityType: existing.entity_type,
      data: mergedData,
      provenance: { source_ref: prov.source_ref, confirmed_by: prov.confirmed_by, confirmed_at: prov.confirmed_at },
      source_ref: prov.source_ref,
      confirmed_by: prov.confirmed_by,
      confirmed_at: prov.confirmed_at,
    }
  }

  async getInstance(id: string): Promise<Instance | null> {
    assertSafeIdentifier(this.schema, 'getInstance')
    const res = await this.exec.query<InstanceRow>(
      `SELECT id, entity_type, data, source_ref, confirmed_by, confirmed_at
         FROM "${this.schema}".instances WHERE id = $1`,
      [id],
    )
    const row = res.rows[0]
    if (row === undefined) return null
    return rowToInstance(row)
  }

  /**
   * Batch sibling of getInstance — ONE round-trip for N ids.
   *
   * Why this exists: neighbors() resolved its id set with a per-id getInstance
   * loop, so a list screen that walked one relationship per row issued N+1
   * queries. Under an adapter view that opens a transaction per read that is
   * N+1 *transactions*; a downstream app measured 16s on a plain list and had
   * to abandon the graph API for hand-written SQL views.
   *
   * Order follows `ids`; missing ids are omitted (same contract as getInstance
   * returning null, just collapsed). Duplicate ids yield one row.
   */
  async getInstances(ids: readonly string[]): Promise<Instance[]> {
    assertSafeIdentifier(this.schema, 'getInstances')
    if (ids.length === 0) return []
    const unique = [...new Set(ids)]
    // ⚠️ `::uuid[]`, not `::text[]`. `id` is uuid, and a single-value `= $1`
    //    lets Postgres infer the parameter's type — an array does not, so
    //    text[] gives "operator does not exist: uuid = text". Casting the
    //    COLUMN instead would work and would also throw the index away.
    const res = await this.exec.query<InstanceRow>(
      `SELECT id, entity_type, data, source_ref, confirmed_by, confirmed_at
         FROM "${this.schema}".instances WHERE id = ANY($1::uuid[])`,
      [unique],
    )
    const byId = new Map(res.rows.map((row) => [row.id, rowToInstance(row)]))
    return unique.flatMap((id) => {
      const inst = byId.get(id)
      return inst === undefined ? [] : [inst]
    })
  }

  async queryInstances(type: string, cond: ConditionExpr | null): Promise<Instance[]> {
    assertSafeIdentifier(this.schema, 'queryInstances')
    // Coarse pre-filter in SQL so the store stops shipping the whole entity type
    // over the wire. It may return EXTRA rows but never drops one that JS keeps —
    // see condition-sql.ts. The JS pass below is untouched, so QG-5 parity with
    // InMemoryAdapter holds by construction, not by luck.
    const pushed = compilePropertyFilter(cond, type, 2)
    const res = await this.exec.query<InstanceRow>(
      `SELECT id, entity_type, data, source_ref, confirmed_by, confirmed_at
         FROM "${this.schema}".instances
        WHERE entity_type = $1${pushed === null ? '' : ` AND ${pushed.sql}`}`,
      [type, ...(pushed?.params ?? [])],
    )
    const instances = res.rows.map(rowToInstance)
    if (cond === null) return instances
    // Filter in JS using the shared matchesProperties for byte-identical parity
    // with InMemoryAdapter (QG-5). No ConditionExpr value ever decides the result.
    return instances.filter((inst) => matchesProperties(cond, inst.data))
  }

  // ── Edges ─────────────────────────────────────────────────────────────────────

  async insertEdge(
    relationship: string,
    fromId: string,
    toId: string,
    prov: Provenance,
  ): Promise<Edge> {
    assertSafeIdentifier(this.schema, 'insertEdge')
    const id = randomUUID()
    const now = new Date().toISOString()
    // INSERT ... ON CONFLICT DO NOTHING (idempotent by UNIQUE(rel, from_id, to_id))
    await this.exec.query(
      `INSERT INTO "${this.schema}".edges
         (id, rel, from_id, to_id, source_ref, confirmed_by, confirmed_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (rel, from_id, to_id) DO NOTHING`,
      [id, relationship, fromId, toId, prov.source_ref, prov.confirmed_by, prov.confirmed_at, now],
    )
    // SELECT the canonical row (may be the newly inserted or pre-existing one)
    const res = await this.exec.query<EdgeRow>(
      `SELECT id, rel, from_id, to_id, source_ref, confirmed_by, confirmed_at
         FROM "${this.schema}".edges
        WHERE rel = $1 AND from_id = $2 AND to_id = $3`,
      [relationship, fromId, toId],
    )
    const row = res.rows[0]
    if (row === undefined) {
      // Should never happen — we just inserted or it already existed
      throw ontologyError('MIGRATION_FAILED', 'insertEdge: row vanished after insert')
    }
    return rowToEdge(row)
  }

  async deleteEdge(relationship: string, fromId: string, toId: string): Promise<void> {
    assertSafeIdentifier(this.schema, 'deleteEdge')
    await this.exec.query(
      `DELETE FROM "${this.schema}".edges WHERE rel = $1 AND from_id = $2 AND to_id = $3`,
      [relationship, fromId, toId],
    )
  }

  async queryEdges(spec: EdgeQuery): Promise<Edge[]> {
    assertSafeIdentifier(this.schema, 'queryEdges')
    const conditions: string[] = []
    const params: unknown[] = []

    if (spec.relationship !== undefined) {
      params.push(spec.relationship)
      conditions.push(`rel = $${params.length}`)
    }
    if (spec.fromId !== undefined) {
      params.push(spec.fromId)
      conditions.push(`from_id = $${params.length}`)
    }
    if (spec.toId !== undefined) {
      params.push(spec.toId)
      conditions.push(`to_id = $${params.length}`)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const res = await this.exec.query<EdgeRow>(
      `SELECT id, rel, from_id, to_id, source_ref, confirmed_by, confirmed_at
         FROM "${this.schema}".edges ${where}`,
      params,
    )
    return res.rows.map(rowToEdge)
  }

  async queryEdgesMulti(spec: MultiEdgeQuery): Promise<Edge[]> {
    assertSafeIdentifier(this.schema, 'queryEdgesMulti')
    const params: unknown[] = []
    const endpoints: string[] = []

    if (spec.fromIds !== undefined) {
      if (spec.fromIds.length === 0 && spec.toIds === undefined) return []
      params.push([...new Set(spec.fromIds)])
      endpoints.push(`from_id = ANY($${params.length}::uuid[])`)
    }
    if (spec.toIds !== undefined) {
      if (spec.toIds.length === 0 && endpoints.length === 0) return []
      params.push([...new Set(spec.toIds)])
      endpoints.push(`to_id = ANY($${params.length}::uuid[])`)
    }

    const conditions: string[] = []
    if (endpoints.length > 0) conditions.push(`(${endpoints.join(' OR ')})`)
    if (spec.relationship !== undefined) {
      params.push(spec.relationship)
      conditions.push(`rel = $${params.length}`)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const res = await this.exec.query<EdgeRow>(
      `SELECT id, rel, from_id, to_id, source_ref, confirmed_by, confirmed_at
         FROM "${this.schema}".edges ${where}`,
      params,
    )
    return res.rows.map(rowToEdge)
  }

  // ── Rules ─────────────────────────────────────────────────────────────────────

  async insertRule(rule: RuleDef): Promise<void> {
    assertSafeIdentifier(this.schema, 'insertRule')
    await this.exec.query(
      `INSERT INTO "${this.schema}".rules
         (id, name, kind, applies_to, condition, severity, message, enabled, version,
          source_ref, confirmed_by, confirmed_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)`,
      [
        rule.id,
        rule.name,
        rule.kind,
        rule.appliesTo,
        JSON.stringify(rule.condition),
        rule.severity,
        rule.message,
        rule.enabled,
        rule.version,
        rule.source_ref,
        rule.confirmed_by,
        rule.confirmed_at,
      ],
    )
  }

  async getRule(id: string): Promise<RuleDef | null> {
    assertSafeIdentifier(this.schema, 'getRule')
    const res = await this.exec.query<RuleRow>(
      `SELECT id, name, kind, applies_to, condition, severity, message, enabled, version,
              source_ref, confirmed_by, confirmed_at
         FROM "${this.schema}".rules WHERE id = $1`,
      [id],
    )
    const row = res.rows[0]
    if (row === undefined) return null
    return rowToRule(row)
  }

  async updateRule(rule: RuleDef): Promise<void> {
    assertSafeIdentifier(this.schema, 'updateRule')
    await this.exec.query(
      `INSERT INTO "${this.schema}".rules
         (id, name, kind, applies_to, condition, severity, message, enabled, version,
          source_ref, confirmed_by, confirmed_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO UPDATE
         SET name         = EXCLUDED.name,
             kind         = EXCLUDED.kind,
             applies_to   = EXCLUDED.applies_to,
             condition    = EXCLUDED.condition,
             severity     = EXCLUDED.severity,
             message      = EXCLUDED.message,
             enabled      = EXCLUDED.enabled,
             version      = EXCLUDED.version,
             source_ref   = EXCLUDED.source_ref,
             confirmed_by = EXCLUDED.confirmed_by,
             confirmed_at = EXCLUDED.confirmed_at`,
      [
        rule.id,
        rule.name,
        rule.kind,
        rule.appliesTo,
        JSON.stringify(rule.condition),
        rule.severity,
        rule.message,
        rule.enabled,
        rule.version,
        rule.source_ref,
        rule.confirmed_by,
        rule.confirmed_at,
      ],
    )
  }

  async queryRules(filter?: { appliesTo?: string; enabled?: boolean }): Promise<RuleDef[]> {
    assertSafeIdentifier(this.schema, 'queryRules')
    const conditions: string[] = []
    const params: unknown[] = []

    if (filter?.appliesTo !== undefined) {
      params.push(filter.appliesTo)
      conditions.push(`applies_to = $${params.length}`)
    }
    if (filter?.enabled !== undefined) {
      params.push(filter.enabled)
      conditions.push(`enabled = $${params.length}`)
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const res = await this.exec.query<RuleRow>(
      `SELECT id, name, kind, applies_to, condition, severity, message, enabled, version,
              source_ref, confirmed_by, confirmed_at
         FROM "${this.schema}".rules ${where}`,
      params,
    )
    return res.rows.map(rowToRule)
  }

  async insertRuleIfAbsent(rule: RuleDef): Promise<boolean> {
    assertSafeIdentifier(this.schema, 'insertRuleIfAbsent')
    const res = await this.exec.query(
      `INSERT INTO "${this.schema}".rules
         (id, name, kind, applies_to, condition, severity, message, enabled, version,
          source_ref, confirmed_by, confirmed_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        rule.id, rule.name, rule.kind, rule.appliesTo,
        JSON.stringify(rule.condition), rule.severity, rule.message,
        rule.enabled, rule.version,
        rule.source_ref, rule.confirmed_by, rule.confirmed_at,
      ],
    )
    return (res.rowCount ?? 0) > 0
  }

  async atomicDisableRule(id: string, prov: Provenance): Promise<'ok' | 'not_found'> {
    assertSafeIdentifier(this.schema, 'atomicDisableRule')
    const res = await this.exec.query(
      `UPDATE "${this.schema}".rules
          SET enabled      = false,
              version      = version + 1,
              source_ref   = $2,
              confirmed_by = $3,
              confirmed_at = $4
        WHERE id = $1
        RETURNING id`,
      [id, prov.source_ref, prov.confirmed_by, prov.confirmed_at],
    )
    return (res.rowCount ?? 0) > 0 ? 'ok' : 'not_found'
  }
}
