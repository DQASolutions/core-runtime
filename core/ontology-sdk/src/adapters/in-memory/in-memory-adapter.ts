// Layer 1 — InMemoryAdapter. Map-backed StorageAdapter; the QG-5 parity target
// and the fast inner-loop test backend (C-002). Mirrors the Postgres logical
// model (data-model §6). Persists only — every ontology invariant is enforced
// ABOVE it in Layer 2, which is why the same suite passes here and on Postgres.

import { randomUUID } from 'node:crypto'
import {
  type ConditionExpr,
  type Edge,
  type Instance,
  type MigrationChange,
  type MigrationReport,
  type OntologySchema,
  type Provenance,
  type RuleDef,
} from '../../types/index.js'
import type {
  EdgeQuery,
  MultiEdgeQuery,
  Row,
  StorageAdapter,
  UnitOfWork,
} from '../../ports/storage-adapter.js'
import { matchesProperties } from '../../shared/condition-match.js'

interface TenantStore {
  schema: OntologySchema | null
  instances: Map<string, Instance>
  edges: Map<string, Edge>
  rules: Map<string, RuleDef>
}

function emptyStore(): TenantStore {
  return { schema: null, instances: new Map(), edges: new Map(), rules: new Map() }
}

export class InMemoryAdapter implements StorageAdapter {
  // The root map is SHARED across withTenant() views so one logical adapter
  // keeps all tenants' isolated buckets in one place.
  private readonly root: Map<string, TenantStore>
  private readonly tenantId: string

  constructor(root?: Map<string, TenantStore>, tenantId = '__default__') {
    this.root = root ?? new Map()
    this.tenantId = tenantId
  }

  // @impl BR-012, BR-015

  /**
   * ⭐ CHỖ DUY NHẤT dựng một bản sao của adapter này. `withTenant` đi qua đây, nên
   *    một lớp con chỉ cần đè MỘT hàm này là mọi bản sao của nó vẫn là kiểu của
   *    nó — thay vì tụt lặng lẽ về lớp gốc giữa chừng.
   *
   * ⛔ Thêm 5/9/2026, sau khi vấp thật. `PostgresAdapter` có `spawn()` từ trước
   *    và chú thích ở đó đã cảnh báo đúng chuyện này — "silently degrading to a
   *    plain adapter mid-transaction, the kind of bug that only shows up on the
   *    write path under load" — nhưng bốn adapter còn lại không có. Hậu quả đo
   *    được: một phép thử dựng lớp con của `InMemoryAdapter` để đếm giao dịch;
   *    `applyAction` gọi `withTenant`, lớp con biến mất, và phép thử đo một
   *    adapter KHÁC cái nó dựng — bốn phép xanh sai trước khi ai hiểu ra.
   */
  protected spawn(root: Map<string, TenantStore>, tenantId: string): StorageAdapter {
    return new InMemoryAdapter(root, tenantId)
  }

  withTenant(tenantId: string): StorageAdapter {
    return this.spawn(this.root, tenantId)
  }

  private store(): TenantStore {
    let s = this.root.get(this.tenantId)
    if (!s) {
      s = emptyStore()
      this.root.set(this.tenantId, s)
    }
    return s
  }

  // Atomic unit of work via snapshot/restore. Writes mutate the tenant bucket in
  // place (set/delete of map entries holding immutable values); on any throw we
  // restore the cloned maps, so a failed effect — or a failed event append — rolls
  // back wholesale. No `raw` handle: the InMemoryEventStore keeps its own log and
  // appends last, so a thrown append leaves nothing persisted. (M2)
  async withTransaction<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T> {
    const s = this.store()
    const snapshot: TenantStore = {
      schema: s.schema,
      instances: new Map(s.instances),
      edges: new Map(s.edges),
      rules: new Map(s.rules),
    }
    try {
      return await fn({ tenantId: this.tenantId, adapter: this })
    } catch (err) {
      this.root.set(this.tenantId, snapshot)
      throw err
    }
  }

  // Drop this tenant's entire bucket — instances, edges, rules, schema.
  async clearTenant(): Promise<void> {
    this.root.delete(this.tenantId)
  }

  async applySchema(schema: OntologySchema): Promise<MigrationReport> {
    const s = this.store()
    const prevSchema = s.schema

    // @impl S003-AC-011
    // Build changes: compare against previously applied schema (idempotency, FR-N03).
    // @impl S003-AC-011
    // EntityTypes must be applied before RelationshipTypes (FR-N04).
    const changes: MigrationChange[] = []

    const prevEntityNames = new Set(prevSchema?.entityTypes.map((e) => e.name) ?? [])
    for (const et of schema.entityTypes) {
      changes.push({
        type: 'EntityType',
        name: et.name,
        op: prevEntityNames.has(et.name) ? 'no-op' : 'created',
      })
    }

    const prevRelNames = new Set(prevSchema?.relationshipTypes.map((r) => r.name) ?? [])
    for (const rt of schema.relationshipTypes) {
      changes.push({
        type: 'RelationshipType',
        name: rt.name,
        op: prevRelNames.has(rt.name) ? 'no-op' : 'created',
      })
    }

    s.schema = schema

    return {
      appliedAt: new Date().toISOString(),
      changes,
      errors: [],
    // @impl S004-AC-007
    }
  // @impl S004-AC-007
  }
// @impl S004-AC-007

  // @impl S004-AC-007
  async insertInstance(type: string, data: Row, prov: Provenance): Promise<Instance> {
    const inst: Instance = {
      id: randomUUID(),
      entityType: type,
      data: { ...data },
      provenance: { source_ref: prov.source_ref, confirmed_by: prov.confirmed_by, confirmed_at: prov.confirmed_at },
      source_ref: prov.source_ref,
      confirmed_by: prov.confirmed_by,
      confirmed_at: prov.confirmed_at,
    }
    this.store().instances.set(inst.id, inst)
    return { ...inst, data: { ...inst.data }, provenance: { ...inst.provenance } }
  }

  // Create-or-replace at a caller-supplied (deterministic) id. Idempotent: a
  // re-run with the same id overwrites the node's data + provenance in place.
  async upsertInstance(id: string, type: string, data: Row, prov: Provenance): Promise<Instance> {
    const inst: Instance = {
      id,
      entityType: type,
      data: { ...data },
      provenance: { source_ref: prov.source_ref, confirmed_by: prov.confirmed_by, confirmed_at: prov.confirmed_at },
      source_ref: prov.source_ref,
      confirmed_by: prov.confirmed_by,
      confirmed_at: prov.confirmed_at,
    }
    this.store().instances.set(id, inst)
    return { ...inst, data: { ...inst.data }, provenance: { ...inst.provenance } }
  }

  /**
   * So-rồi-đặt. Phần so và phần ghi nằm giữa hai lần `await` — nên trong Node
   * không lệnh nào chen vào được, và đó chính là điều cần.
   */
  async compareAndSetInstance(id: string, expected: Row, patch: Row, prov: Provenance): Promise<boolean> {
    const s = this.store()
    const existing = s.instances.get(id)
    if (!existing) return false
    for (const [k, v] of Object.entries(expected)) {
      const cur = existing.data[k]
      // Vắng mặt và null là một — nếu không thì lần ghi đầu tiên luôn trượt.
      if ((cur ?? null) !== (v ?? null)) return false
    }
    s.instances.set(id, {
      ...existing,
      data: { ...existing.data, ...patch },
      provenance: { source_ref: prov.source_ref, confirmed_by: prov.confirmed_by, confirmed_at: prov.confirmed_at },
      source_ref: prov.source_ref,
      confirmed_by: prov.confirmed_by,
      confirmed_at: prov.confirmed_at,
    })
    return true
  }

  async updateInstance(id: string, patch: Row, prov: Provenance): Promise<Instance> {
    const s = this.store()
    const existing = s.instances.get(id)
    if (!existing) {
      throw new Error(`INSTANCE_NOT_FOUND: ${id}`)
    }
    const updated: Instance = {
      ...existing,
      data: { ...existing.data, ...patch },
      provenance: { source_ref: prov.source_ref, confirmed_by: prov.confirmed_by, confirmed_at: prov.confirmed_at },
      source_ref: prov.source_ref,
      confirmed_by: prov.confirmed_by,
      confirmed_at: prov.confirmed_at,
    }
    s.instances.set(id, updated)
    return { ...updated, data: { ...updated.data }, provenance: { ...updated.provenance } }
  }

  async getInstance(id: string): Promise<Instance | null> {
    const inst = this.store().instances.get(id)
    return inst ? { ...inst, data: { ...inst.data } } : null
  }

  // Batch sibling — trivial here, but present so the parity suite exercises the
  // same door every backend takes (QG-5). Order follows `ids`; misses omitted.
  async getInstances(ids: readonly string[]): Promise<Instance[]> {
    const store = this.store().instances
    return [...new Set(ids)].flatMap((id) => {
      const inst = store.get(id)
      return inst === undefined ? [] : [{ ...inst, data: { ...inst.data } }]
    })
  }

  async queryInstances(type: string, cond: ConditionExpr | null): Promise<Instance[]> {
    const out: Instance[] = []
    for (const inst of this.store().instances.values()) {
      if (inst.entityType !== type) continue
      if (cond && !matchesProperties(cond, inst.data)) continue
      out.push({ ...inst, data: { ...inst.data } })
    }
    return out
  }

  async insertEdge(
    // @impl S005-AC-007
    relationship: string,
    fromId: string,
    // @impl S005-AC-007
    toId: string,
    prov: Provenance,
  // @impl S005-AC-007
  ): Promise<Edge> {
    const s = this.store()
    // @impl S005-AC-007
    // Idempotency on (rel, from, to) — a duplicate link resolves to the existing edge.
    for (const e of s.edges.values()) {
      if (e.relationship === relationship && e.fromId === fromId && e.toId === toId) {
        return { ...e, provenance: { ...e.provenance } }
      }
    }
    const edge: Edge = {
      id: randomUUID(),
      relationship,
      fromId,
      toId,
      provenance: { source_ref: prov.source_ref, confirmed_by: prov.confirmed_by, confirmed_at: prov.confirmed_at },
      source_ref: prov.source_ref,
      confirmed_by: prov.confirmed_by,
      confirmed_at: prov.confirmed_at,
    }
    s.edges.set(edge.id, edge)
    return { ...edge, provenance: { ...edge.provenance } }
  }

  async deleteEdge(relationship: string, fromId: string, toId: string): Promise<void> {
    const s = this.store()
    for (const [id, e] of s.edges) {
      if (e.relationship === relationship && e.fromId === fromId && e.toId === toId) {
        s.edges.delete(id)
        return
      }
    }
    throw new Error(`EDGE_NOT_FOUND: (${relationship}, ${fromId}, ${toId})`)
  }

  async queryEdges(spec: EdgeQuery): Promise<Edge[]> {
    const out: Edge[] = []
    for (const e of this.store().edges.values()) {
      if (spec.relationship !== undefined && e.relationship !== spec.relationship) continue
      if (spec.fromId !== undefined && e.fromId !== spec.fromId) continue
      if (spec.toId !== undefined && e.toId !== spec.toId) continue
      out.push({ ...e, provenance: { ...e.provenance } })
    }
    return out
  }

  async queryEdgesMulti(spec: MultiEdgeQuery): Promise<Edge[]> {
    const from = spec.fromIds === undefined ? undefined : new Set(spec.fromIds)
    const to = spec.toIds === undefined ? undefined : new Set(spec.toIds)
    const out: Edge[] = []
    for (const e of this.store().edges.values()) {
      if (spec.relationship !== undefined && e.relationship !== spec.relationship) continue
      // fromIds OR toIds; neither given = no endpoint restriction at all.
      if (from !== undefined || to !== undefined) {
        const hit = (from?.has(e.fromId) ?? false) || (to?.has(e.toId) ?? false)
        if (!hit) continue
      }
      out.push({ ...e, provenance: { ...e.provenance } })
    }
    return out
  }

  async insertRule(rule: RuleDef): Promise<void> {
    this.store().rules.set(rule.id, { ...rule })
  }

  async getRule(id: string): Promise<RuleDef | null> {
    const r = this.store().rules.get(id)
    return r ? { ...r } : null
  }

  async updateRule(rule: RuleDef): Promise<void> {
    this.store().rules.set(rule.id, { ...rule })
  }

  // Atomic variants — no await between read and write, so concurrent JS tasks
  // cannot interleave and produce TOCTOU races.
  async insertRuleIfAbsent(rule: RuleDef): Promise<boolean> {
    const s = this.store()
    if (s.rules.has(rule.id)) return false
    s.rules.set(rule.id, { ...rule })
    return true
  }

  async atomicDisableRule(id: string, prov: Provenance): Promise<'ok' | 'not_found'> {
    const s = this.store()
    const rule = s.rules.get(id)
    if (!rule) return 'not_found'
    s.rules.set(id, {
      ...rule,
      enabled: false,
      version: rule.version + 1,
      source_ref: prov.source_ref,
      confirmed_by: prov.confirmed_by,
      confirmed_at: prov.confirmed_at,
    })
    return 'ok'
  }

  async queryRules(filter?: { appliesTo?: string; enabled?: boolean }): Promise<RuleDef[]> {
    const out: RuleDef[] = []
    for (const r of this.store().rules.values()) {
      if (filter?.appliesTo !== undefined && r.appliesTo !== filter.appliesTo) continue
      if (filter?.enabled !== undefined && r.enabled !== filter.enabled) continue
      out.push({ ...r })
    }
    return out
  }
}
