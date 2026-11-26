// Layer 1 — Neo4jAdapter. The ONLY layer allowed to import neo4j-driver.
// Implements StorageAdapter over a Bolt connection, modelling the ontology as a
// property graph (its natural shape):
//
//   • Instance  → (:Instance { id, _tenant, entityType, data, <prov> })
//   • Edge      → (:Instance)-[:LINK { id, _tenant, rel, <prov> }]->(:Instance)
//   • RuleDef   → (:Rule      { id, _tenant, ...rule, condition })
//   • schema    → (:OntologySchema { _tenant, schema })  (one per tenant)
//
// Tenancy is a `_tenant` property filtered in every query (portable across
// Community + Enterprise — no multi-database requirement). The free-form `data`
// bag and the rule `condition` tree are stored as JSON strings (Neo4j node
// properties can't hold nested maps); ConditionExpr filtering happens in JS via
// the shared matchesProperties, byte-identical to the other adapters (QG-5) — no
// ConditionExpr value is ever interpolated into Cypher.

import { randomUUID } from 'node:crypto'
import type { Driver } from 'neo4j-driver'

import type {
  ConditionExpr,
  Edge,
  Instance,
  MigrationChange,
  MigrationReport,
  OntologySchema,
  Provenance,
  RuleDef,
} from '../../types/index.js'
import type { BulkEdgeRow, BulkInstanceRow, EdgeQuery, Row, StorageAdapter } from '../../ports/storage-adapter.js'
import { ontologyError } from '../../types/index.js'
import { matchesProperties } from '../../shared/condition-match.js'
import { loadDriver } from '../load-driver.js'

/** neo4j-driver, loaded when first needed (optional peer). */
const neo4j = (): typeof import('neo4j-driver') => loadDriver<typeof import('neo4j-driver')>('neo4j-driver', 'Neo4jAdapter')

// ── Public options type ────────────────────────────────────────────────────────

export interface Neo4jAdapterOptions {
  /** Bolt URL, e.g. `bolt://localhost:7687` or `neo4j+s://…`. Env: NEO4J_URL. */
  url?: string
  /** Username. Env: NEO4J_USER (default `neo4j`). */
  user?: string
  /** Password. Env: NEO4J_PASSWORD (default `neo4j`). */
  password?: string
  /** Target database (Enterprise multi-db). Env: NEO4J_DATABASE (default: server default). */
  database?: string
  /** Inject a shared driver instead of constructing one (used by withTenant). */
  driver?: Driver
}

export class Neo4jAdapter implements StorageAdapter {
  private readonly driver: Driver
  private readonly database: string | undefined
  /** Tenant this adapter instance is scoped to. */
  private readonly tenantId: string

  constructor(opts: Neo4jAdapterOptions = {}, tenantId = '__default__') {
    if (opts.driver !== undefined) {
      this.driver = opts.driver
    } else {
      const url = opts.url ?? process.env['NEO4J_URL'] ?? 'bolt://localhost:7687'
      const user = opts.user ?? process.env['NEO4J_USER'] ?? 'neo4j'
      const password = opts.password ?? process.env['NEO4J_PASSWORD'] ?? 'neo4j'
      // disableLosslessIntegers: return JS numbers (not neo4j Integer) so rule
      // versions and any integral values round-trip as plain numbers.
      const { driver: createDriver, auth } = neo4j()
      this.driver = createDriver(url, auth.basic(user, password), { disableLosslessIntegers: true })
    }
    this.database = opts.database ?? process.env['NEO4J_DATABASE'] ?? undefined
    this.tenantId = tenantId
  }

  // ── Tenancy ──────────────────────────────────────────────────────────────────


  /**
   * ⭐ CHỖ DUY NHẤT dựng một bản sao của adapter này — xem chú thích cùng tên ở
   *    `PostgresAdapter.spawn`. Lớp con đè MỘT hàm này thì mọi bản sao vẫn là
   *    kiểu của nó, thay vì tụt lặng lẽ về lớp gốc giữa chừng. Thêm 5/9/2026.
   */
  protected spawn(opts: Neo4jAdapterOptions, tenantId: string): StorageAdapter {
    return new Neo4jAdapter(opts, tenantId)
  }

  withTenant(tenantId: string): StorageAdapter {
    // Share the driver (one connection pool) across all tenant views.
    const opts: Neo4jAdapterOptions =
      this.database !== undefined ? { driver: this.driver, database: this.database } : { driver: this.driver }
    return this.spawn(opts, tenantId)
  }

  /** Dispose the driver's connection pool. Not part of StorageAdapter — call it
   *  from app shutdown / test teardown to let the process exit cleanly. */
  async close(): Promise<void> {
    await this.driver.close()
  }

  // Delete EVERY node carrying this tenant's marker (Instance / Rule /
  // OntologySchema), detaching their LINK relationships. Batched in sub-
  // transactions so a large graph (tens of thousands of nodes) clears without
  // exhausting heap; CALL { … } IN TRANSACTIONS requires the auto-commit session
  // this.run uses.
  async clearTenant(): Promise<void> {
    await this.run(
      `MATCH (n { _tenant: $_tenant })
       CALL { WITH n DETACH DELETE n } IN TRANSACTIONS OF 5000 ROWS`,
    )
  }

  /** Run one Cypher statement in its own session; `$_tenant` is always bound. */
  private async run(cypher: string, params: Record<string, unknown> = {}) {
    const session = this.driver.session(this.database !== undefined ? { database: this.database } : {})
    try {
      return await session.run(cypher, { _tenant: this.tenantId, ...params })
    } finally {
      await session.close()
    }
  }

  // ── Schema ─────────────────────────────────────────────────────────────────────

  async applySchema(schema: OntologySchema): Promise<MigrationReport> {
    try {
      // Global uniqueness on ids (UUIDs are globally unique across tenants).
      await this.run('CREATE CONSTRAINT instance_id IF NOT EXISTS FOR (n:Instance) REQUIRE n.id IS UNIQUE')
      await this.run('CREATE CONSTRAINT rule_id IF NOT EXISTS FOR (n:Rule) REQUIRE n.id IS UNIQUE')

      // Diff against the previously applied schema for this tenant (idempotency).
      const prevRes = await this.run('MATCH (s:OntologySchema {_tenant: $_tenant}) RETURN s.schema AS schema')
      const prevRaw = prevRes.records[0]?.get('schema') as string | undefined
      const prev = prevRaw !== undefined ? (JSON.parse(prevRaw) as OntologySchema) : null

      const prevEntities = new Set(prev?.entityTypes.map((e) => e.name) ?? [])
      const prevRels = new Set(prev?.relationshipTypes.map((r) => r.name) ?? [])
      const changes: MigrationChange[] = [
        ...schema.entityTypes.map((e) => ({
          type: 'EntityType' as const,
          name: e.name,
          op: prevEntities.has(e.name) ? ('no-op' as const) : ('created' as const),
        })),
        ...schema.relationshipTypes.map((r) => ({
          type: 'RelationshipType' as const,
          name: r.name,
          op: prevRels.has(r.name) ? ('no-op' as const) : ('created' as const),
        })),
      ]

      await this.run('MERGE (s:OntologySchema {_tenant: $_tenant}) SET s.schema = $schema', {
        schema: JSON.stringify(schema),
      })

      return { appliedAt: new Date().toISOString(), changes, errors: [] }
    } catch (err) {
      throw ontologyError(
        'MIGRATION_FAILED',
        `applySchema failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: String(err) },
      )
    }
  }

  // ── Instances ────────────────────────────────────────────────────────────────

  async insertInstance(type: string, data: Row, prov: Provenance): Promise<Instance> {
    const id = randomUUID()
    await this.run(
      `CREATE (n:Instance {
         id: $id, _tenant: $_tenant, entityType: $type, data: $data,
         source_ref: $source_ref, confirmed_by: $confirmed_by, confirmed_at: $confirmed_at })`,
      { id, type, data: JSON.stringify(data), ...prov },
    )
    return buildInstance(id, type, { ...data }, prov)
  }

  // Create-or-replace at a caller-supplied (deterministic) id. MERGE on the
  // globally-unique id then SET overwrites entityType/data/provenance — so an
  // ingest re-run with the same ref updates the same node instead of duplicating.
  async upsertInstance(id: string, type: string, data: Row, prov: Provenance): Promise<Instance> {
    await this.run(
      `MERGE (n:Instance { id: $id })
       SET n._tenant = $_tenant, n.entityType = $type, n.data = $data,
           n.source_ref = $source_ref, n.confirmed_by = $confirmed_by, n.confirmed_at = $confirmed_at`,
      { id, type, data: JSON.stringify(data), ...prov },
    )
    return buildInstance(id, type, { ...data }, prov)
  }

  async updateInstance(id: string, patch: Row, prov: Provenance): Promise<Instance> {
    const cur = await this.run('MATCH (n:Instance {id: $id, _tenant: $_tenant}) RETURN n.entityType AS t, n.data AS d', { id })
    const row = cur.records[0]
    if (row === undefined) throw ontologyError('INSTANCE_NOT_FOUND', `Instance "${id}" not found`)
    const merged = { ...(JSON.parse(row.get('d') as string) as Record<string, unknown>), ...patch }
    await this.run(
      `MATCH (n:Instance {id: $id, _tenant: $_tenant})
       SET n.data = $data, n.source_ref = $source_ref, n.confirmed_by = $confirmed_by, n.confirmed_at = $confirmed_at`,
      { id, data: JSON.stringify(merged), ...prov },
    )
    return buildInstance(id, row.get('t') as string, merged, prov)
  }

  async getInstance(id: string): Promise<Instance | null> {
    const res = await this.run(
      `MATCH (n:Instance {id: $id, _tenant: $_tenant})
       RETURN n.entityType AS t, n.data AS d, n.source_ref AS sr, n.confirmed_by AS cb, n.confirmed_at AS ca`,
      { id },
    )
    const row = res.records[0]
    if (row === undefined) return null
    return rowToInstance(id, row)
  }

  async queryInstances(type: string, cond: ConditionExpr | null): Promise<Instance[]> {
    const res = await this.run(
      `MATCH (n:Instance {entityType: $type, _tenant: $_tenant})
       RETURN n.id AS id, n.entityType AS t, n.data AS d, n.source_ref AS sr, n.confirmed_by AS cb, n.confirmed_at AS ca`,
      { type },
    )
    const instances = res.records.map((r) => rowToInstance(r.get('id') as string, r))
    // Filter in JS for byte-identical parity with the other adapters (QG-5).
    return cond === null ? instances : instances.filter((inst) => matchesProperties(cond, inst.data))
  }

  // ── Edges ──────────────────────────────────────────────────────────────────────

  async insertEdge(relationship: string, fromId: string, toId: string, prov: Provenance): Promise<Edge> {
    const id = randomUUID()
    // Idempotent on (rel, from, to): MERGE matches an existing LINK or creates one;
    // a duplicate link resolves to the existing edge (its original id + provenance).
    const res = await this.run(
      `MATCH (a:Instance {id: $fromId, _tenant: $_tenant}), (b:Instance {id: $toId, _tenant: $_tenant})
       MERGE (a)-[r:LINK {rel: $rel}]->(b)
       ON CREATE SET r.id = $id, r._tenant = $_tenant,
                     r.source_ref = $source_ref, r.confirmed_by = $confirmed_by, r.confirmed_at = $confirmed_at
       RETURN r.id AS id, r.source_ref AS sr, r.confirmed_by AS cb, r.confirmed_at AS ca`,
      { id, rel: relationship, fromId, toId, ...prov },
    )
    const row = res.records[0]
    if (row === undefined) {
      // MERGE never matched the endpoints — both Instances must exist first
      // (Layer 2 validates this before calling; defensive guard here).
      throw new Error(`ENDPOINT_NOT_FOUND: insertEdge (${relationship}, ${fromId}, ${toId})`)
    }
    return {
      id: row.get('id') as string,
      relationship,
      fromId,
      toId,
      provenance: { source_ref: row.get('sr') as string, confirmed_by: row.get('cb') as string, confirmed_at: row.get('ca') as string },
      source_ref: row.get('sr') as string,
      confirmed_by: row.get('cb') as string,
      confirmed_at: row.get('ca') as string,
    }
  }

  // ── Bulk write (UNWIND) ──────────────────────────────────────────────────────
  // One round-trip per BULK_BATCH rows instead of one per item — the ingest hot
  // path (70k+ instances, 120k+ edges). Provenance is uniform across a batch, so
  // it rides as scalar params; only the per-row id/type/data/endpoints UNWIND.

  async bulkUpsertInstances(rows: BulkInstanceRow[], prov: Provenance): Promise<void> {
    for (const batch of chunk(rows, BULK_BATCH)) {
      await this.run(
        `UNWIND $rows AS r
         MERGE (n:Instance { id: r.id })
         SET n._tenant = $_tenant, n.entityType = r.type, n.data = r.data,
             n.source_ref = coalesce(r.sourceRef, $source_ref),
             n.confirmed_by = $confirmed_by, n.confirmed_at = $confirmed_at`,
        { rows: batch.map((r) => ({ id: r.id, type: r.type, data: JSON.stringify(r.data), sourceRef: r.sourceRef ?? null })), ...prov },
      )
    }
  }

  async bulkCreateInstances(rows: BulkInstanceRow[], prov: Provenance): Promise<void> {
    for (const batch of chunk(rows, BULK_BATCH)) {
      await this.run(
        `UNWIND $rows AS r
         CREATE (n:Instance { id: r.id, _tenant: $_tenant, entityType: r.type, data: r.data,
                 source_ref: coalesce(r.sourceRef, $source_ref),
                 confirmed_by: $confirmed_by, confirmed_at: $confirmed_at })`,
        { rows: batch.map((r) => ({ id: r.id, type: r.type, data: JSON.stringify(r.data), sourceRef: r.sourceRef ?? null })), ...prov },
      )
    }
  }

  /**
   * Returns how many edges EXIST after the operation — not how many were requested.
   *
   * MATCH on both endpoints means a row with a missing endpoint yields no match and is skipped. That part
   * is correct and must stay: a missing counterpart is a legitimate state (the client simply has not filed
   * that document yet), not an error to throw on.
   *
   * What was wrong is that the skip was UNOBSERVABLE. The old comment justified it with "the payload is
   * pre-validated upstream" — an assumption that failed five separate times in one day on real data, each
   * time for a different reason (step ordering, a ref from another payload, a target account absent from the
   * trial balance, two account codes in one cell). Every one of them looked exactly like success: no error,
   * no log, and the caller reported the REQUESTED count as if it were the achieved one.
   *
   * A write that cannot report what it did forces every caller to re-measure the graph afterwards to learn
   * the truth — and a caller that forgets is silently blind. So the count is returned here, at the only
   * layer that actually knows.
   */
  async bulkInsertEdges(rows: BulkEdgeRow[], prov: Provenance): Promise<number> {
    let linked = 0
    for (const batch of chunk(rows, BULK_BATCH)) {
      const res = await this.run(
        `UNWIND $rows AS r
         MATCH (a:Instance { id: r.fromId, _tenant: $_tenant }), (b:Instance { id: r.toId, _tenant: $_tenant })
         MERGE (a)-[e:LINK { rel: r.rel }]->(b)
         ON CREATE SET e.id = r.id, e._tenant = $_tenant,
                       e.source_ref = $source_ref, e.confirmed_by = $confirmed_by, e.confirmed_at = $confirmed_at
         RETURN count(e) AS linked`,
        { rows: batch.map((r) => ({ rel: r.relationship, fromId: r.fromId, toId: r.toId, id: randomUUID() })), ...prov },
      )
      // MERGE also matches an edge that already exists, so this is "edges present after the write", which is
      // exactly the fact a caller needs — re-running an ingest must not look like a failure.
      linked += Number(res.records[0]?.get('linked') ?? 0)
    }
    return linked
  }

  async deleteEdge(relationship: string, fromId: string, toId: string): Promise<void> {
    const res = await this.run(
      `MATCH (a:Instance {id: $fromId, _tenant: $_tenant})-[r:LINK {rel: $rel}]->(b:Instance {id: $toId, _tenant: $_tenant})
       DELETE r`,
      { rel: relationship, fromId, toId },
    )
    if (res.summary.counters.updates().relationshipsDeleted === 0) {
      throw new Error(`EDGE_NOT_FOUND: (${relationship}, ${fromId}, ${toId})`)
    }
  }

  async queryEdges(spec: EdgeQuery): Promise<Edge[]> {
    // Chỉ đưa vào mẫu những điều kiện THẬT SỰ có giá trị. Viết kiểu `($fromId IS NULL OR a.id = $fromId)` thì bộ lập kế hoạch
    // không neo được vào chỉ mục `Instance.id`: mỗi lần hỏi "cạnh này có chưa" phải quét mọi cạnh của tenant, nên một lần
    // `link` chậm dần theo kích thước cả đồ thị (đo: 101.729 lần chạm dữ liệu so với 1.328 trên đồ thị 55 nghìn cạnh).
    const end = (id: string | null | undefined, param: string) => (id != null ? `{id: $${param}, _tenant: $_tenant}` : '{_tenant: $_tenant}')
    const rel = spec.relationship != null ? ' {rel: $rel}' : ''
    const res = await this.run(
      `MATCH (a:Instance ${end(spec.fromId, 'fromId')})-[r:LINK${rel}]->(b:Instance ${end(spec.toId, 'toId')})
       RETURN r.id AS id, r.rel AS rel, a.id AS fromId, b.id AS toId,
              r.source_ref AS sr, r.confirmed_by AS cb, r.confirmed_at AS ca`,
      { rel: spec.relationship ?? null, fromId: spec.fromId ?? null, toId: spec.toId ?? null },
    )
    return res.records.map((r) => ({
      id: r.get('id') as string,
      relationship: r.get('rel') as string,
      fromId: r.get('fromId') as string,
      toId: r.get('toId') as string,
      provenance: { source_ref: r.get('sr') as string, confirmed_by: r.get('cb') as string, confirmed_at: r.get('ca') as string },
      source_ref: r.get('sr') as string,
      confirmed_by: r.get('cb') as string,
      confirmed_at: r.get('ca') as string,
    }))
  }

  // ── Rules (stored as data — NT4) ─────────────────────────────────────────────

  async insertRule(rule: RuleDef): Promise<void> {
    await this.run(`CREATE (n:Rule ${RULE_SET})`, ruleParams(rule))
  }

  async getRule(id: string): Promise<RuleDef | null> {
    const res = await this.run(`MATCH (n:Rule {id: $id, _tenant: $_tenant}) RETURN ${RULE_RETURN}`, { id })
    const row = res.records[0]
    return row === undefined ? null : rowToRule(row)
  }

  async updateRule(rule: RuleDef): Promise<void> {
    // Upsert (matches Postgres ON CONFLICT DO UPDATE / in-memory set).
    await this.run(`MERGE (n:Rule {id: $id, _tenant: $_tenant}) SET n += ${RULE_PROPS}`, ruleParams(rule))
  }

  async insertRuleIfAbsent(rule: RuleDef): Promise<boolean> {
    const res = await this.run(
      `MERGE (n:Rule {id: $id, _tenant: $_tenant}) ON CREATE SET n += ${RULE_PROPS} RETURN n.id`,
      ruleParams(rule),
    )
    return res.summary.counters.updates().nodesCreated > 0
  }

  async atomicDisableRule(id: string, prov: Provenance): Promise<'ok' | 'not_found'> {
    const res = await this.run(
      `MATCH (n:Rule {id: $id, _tenant: $_tenant})
       SET n.enabled = false, n.version = n.version + 1,
           n.source_ref = $source_ref, n.confirmed_by = $confirmed_by, n.confirmed_at = $confirmed_at
       RETURN n.id AS id`,
      { id, ...prov },
    )
    return res.records.length > 0 ? 'ok' : 'not_found'
  }

  async queryRules(filter?: { appliesTo?: string; enabled?: boolean }): Promise<RuleDef[]> {
    const res = await this.run(
      `MATCH (n:Rule {_tenant: $_tenant})
       WHERE ($appliesTo IS NULL OR n.applies_to = $appliesTo)
         AND ($enabled IS NULL OR n.enabled = $enabled)
       RETURN ${RULE_RETURN}`,
      { appliesTo: filter?.appliesTo ?? null, enabled: filter?.enabled ?? null },
    )
    return res.records.map(rowToRule)
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────────

// Rows per UNWIND round-trip. Large enough to amortise the ~ms network hop over
// hundreds of writes, small enough to keep the transaction + params bounded.
const BULK_BATCH = 1000

/** Split an array into fixed-size chunks (one UNWIND transaction each). */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

function buildInstance(id: string, entityType: string, data: Record<string, unknown>, prov: Provenance): Instance {
  return {
    id,
    entityType,
    data,
    provenance: { source_ref: prov.source_ref, confirmed_by: prov.confirmed_by, confirmed_at: prov.confirmed_at },
    source_ref: prov.source_ref,
    confirmed_by: prov.confirmed_by,
    confirmed_at: prov.confirmed_at,
  }
}

// neo4j Record is structurally typed via .get(); accept the minimal shape we use.
type Rec = { get(key: string): unknown }

function rowToInstance(id: string, r: Rec): Instance {
  return buildInstance(id, r.get('t') as string, JSON.parse(r.get('d') as string) as Record<string, unknown>, {
    source_ref: r.get('sr') as string,
    confirmed_by: r.get('cb') as string,
    confirmed_at: r.get('ca') as string,
  })
}

// Properties written on a Rule node. condition is JSON; version is an integer.
const RULE_PROPS =
  `{ id: $id, _tenant: $_tenant, name: $name, kind: $kind, applies_to: $applies_to,` +
  ` condition: $condition, severity: $severity, message: $message, enabled: $enabled,` +
  ` version: $version, source_ref: $source_ref, confirmed_by: $confirmed_by, confirmed_at: $confirmed_at }`
const RULE_SET = RULE_PROPS
const RULE_RETURN =
  `n.id AS id, n.name AS name, n.kind AS kind, n.applies_to AS applies_to, n.condition AS condition,` +
  ` n.severity AS severity, n.message AS message, n.enabled AS enabled, n.version AS version,` +
  ` n.source_ref AS source_ref, n.confirmed_by AS confirmed_by, n.confirmed_at AS confirmed_at`

function ruleParams(rule: RuleDef): Record<string, unknown> {
  return {
    id: rule.id,
    name: rule.name,
    kind: rule.kind,
    applies_to: rule.appliesTo,
    condition: JSON.stringify(rule.condition),
    severity: rule.severity,
    message: rule.message,
    enabled: rule.enabled,
    version: neo4j().int(rule.version),
    source_ref: rule.source_ref,
    confirmed_by: rule.confirmed_by,
    confirmed_at: rule.confirmed_at,
  }
}

function rowToRule(r: Rec): RuleDef {
  return {
    id: r.get('id') as string,
    name: r.get('name') as string,
    kind: r.get('kind') as RuleDef['kind'],
    appliesTo: r.get('applies_to') as string,
    condition: JSON.parse(r.get('condition') as string) as RuleDef['condition'],
    severity: r.get('severity') as string,
    message: r.get('message') as string,
    enabled: r.get('enabled') as boolean,
    version: Number(r.get('version')),
    source_ref: r.get('source_ref') as string,
    confirmed_by: r.get('confirmed_by') as string,
    confirmed_at: r.get('confirmed_at') as string,
  }
}
