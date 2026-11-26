// Layer 1 — FilesystemAdapter. One JSON file per Instance / Edge / Rule under a
// tenant-scoped directory tree. Designed for DQA project contexts where files on
// disk are first-class: human-inspectable, git-diffable, no external DB required.
// Uses write-to-tmp + rename for atomicity (partial writes never corrupt the store).
//
// Layout (<basePath>/<tenantId>/):
//   _schema.json
//   instances/<entityType>/<id>.json
//   edges/<id>.json
//   rules/<id>.json
//
// All ontology invariants (provenance, cardinality, endpoint typing, tenant scope)
// are enforced ABOVE this adapter in Layer 2 — the adapter only persists + retrieves.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, unlink, readdir, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
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
import type { EdgeQuery, Row, StorageAdapter } from '../../ports/storage-adapter.js'
import { matchesProperties } from '../../shared/condition-match.js'

// ── File I/O helpers ──────────────────────────────────────────────────────────

async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true })
}

async function atomicWrite(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFile(tmp, JSON.stringify(data, null, 2), 'utf8')
  await rename(tmp, path)
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

async function listJsonFiles(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir)
    return entries.filter((e) => e.endsWith('.json') && !e.endsWith('.tmp'))
  } catch {
    return []
  }
}

// ── Adapter ───────────────────────────────────────────────────────────────────

export class FilesystemAdapter implements StorageAdapter {
  private readonly basePath: string
  private readonly tenantId: string

  constructor(basePath: string, tenantId = '__default__') {
    this.basePath = resolve(basePath)
    this.tenantId = tenantId
  }


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
  protected spawn(basePath: string, tenantId: string): StorageAdapter {
    return new FilesystemAdapter(basePath, tenantId)
  }

  withTenant(tenantId: string): StorageAdapter {
    return this.spawn(this.basePath, tenantId)
  }

  // Delete this tenant's whole directory tree (instances, edges, rules, schema).
  async clearTenant(): Promise<void> {
    await rm(this.root(), { recursive: true, force: true })
  }

  // ── Paths ─────────────────────────────────────────────────────────────────

  private root(): string { return join(this.basePath, this.tenantId) }
  private schemaPath(): string { return join(this.root(), '_schema.json') }
  private instancesRoot(): string { return join(this.root(), 'instances') }
  private instanceDir(type: string): string { return join(this.instancesRoot(), type) }
  private instancePath(type: string, id: string): string { return join(this.instanceDir(type), `${id}.json`) }
  private edgeDir(): string { return join(this.root(), 'edges') }
  private edgePath(id: string): string { return join(this.edgeDir(), `${id}.json`) }
  private ruleDir(): string { return join(this.root(), 'rules') }
  private rulePath(id: string): string { return join(this.ruleDir(), `${id}.json`) }

  // ── Schema ────────────────────────────────────────────────────────────────

  async applySchema(schema: OntologySchema): Promise<MigrationReport> {
    await ensureDir(this.root())
    const prev = await readJson<OntologySchema>(this.schemaPath())
    const prevEntityNames = new Set(prev?.entityTypes.map((e) => e.name) ?? [])
    const prevRelNames = new Set(prev?.relationshipTypes.map((r) => r.name) ?? [])
    const changes: MigrationChange[] = [
      ...schema.entityTypes.map((e) => ({
        type: 'EntityType' as const,
        name: e.name,
        op: prevEntityNames.has(e.name) ? 'no-op' : 'created',
      })),
      ...schema.relationshipTypes.map((r) => ({
        type: 'RelationshipType' as const,
        name: r.name,
        op: prevRelNames.has(r.name) ? 'no-op' : 'created',
      })),
    ]
    await atomicWrite(this.schemaPath(), schema)
    // @impl S003-AC-007, S003-AC-011
    return { appliedAt: new Date().toISOString(), changes, errors: [] }
  }

  // ── Instances ─────────────────────────────────────────────────────────────
// @impl S004-AC-007

  // @impl S004-AC-007
  async insertInstance(type: string, data: Row, prov: Provenance): Promise<Instance> {
    const id = randomUUID()
    const inst: Instance = {
      id,
      entityType: type,
      data: { ...data },
      provenance: { source_ref: prov.source_ref, confirmed_by: prov.confirmed_by, confirmed_at: prov.confirmed_at },
      source_ref: prov.source_ref,
      confirmed_by: prov.confirmed_by,
      confirmed_at: prov.confirmed_at,
    }
    await ensureDir(this.instanceDir(type))
    await atomicWrite(this.instancePath(type, id), inst)
    return { ...inst, data: { ...inst.data }, provenance: { ...inst.provenance } }
  }

  // Create-or-replace at a caller-supplied (deterministic) id. Writes the file
  // for (type, id) atomically — a re-run overwrites it, so ingest is idempotent.
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
    await ensureDir(this.instanceDir(type))
    await atomicWrite(this.instancePath(type, id), inst)
    return { ...inst, data: { ...inst.data }, provenance: { ...inst.provenance } }
  }

  async updateInstance(id: string, patch: Row, prov: Provenance): Promise<Instance> {
    const existing = await this.getInstance(id)
    if (!existing) throw new Error(`INSTANCE_NOT_FOUND: ${id}`)
    const updated: Instance = {
      ...existing,
      data: { ...existing.data, ...patch },
      provenance: { source_ref: prov.source_ref, confirmed_by: prov.confirmed_by, confirmed_at: prov.confirmed_at },
      source_ref: prov.source_ref,
      confirmed_by: prov.confirmed_by,
      confirmed_at: prov.confirmed_at,
    }
    await atomicWrite(this.instancePath(existing.entityType, id), updated)
    return { ...updated, data: { ...updated.data }, provenance: { ...updated.provenance } }
  }

  async getInstance(id: string): Promise<Instance | null> {
    // Scan all entity-type subdirs — entity type is unknown to the caller at this level
    let typeDirs: string[]
    try { typeDirs = await readdir(this.instancesRoot()) } catch { return null }
    for (const typeDir of typeDirs) {
      const inst = await readJson<Instance>(this.instancePath(typeDir, id))
      if (inst) return { ...inst, data: { ...inst.data }, provenance: { ...inst.provenance } }
    }
    return null
  }

  // Batch sibling. The per-id path re-lists the entity-type subdirs every call
  // because the caller does not know the type; batching lists them ONCE, so the
  // directory scan stops multiplying by the number of ids.
  async getInstances(ids: readonly string[]): Promise<Instance[]> {
    if (ids.length === 0) return []
    let typeDirs: string[]
    try { typeDirs = await readdir(this.instancesRoot()) } catch { return [] }
    const out: Instance[] = []
    for (const id of new Set(ids)) {
      for (const typeDir of typeDirs) {
        const inst = await readJson<Instance>(this.instancePath(typeDir, id))
        if (inst) {
          out.push({ ...inst, data: { ...inst.data }, provenance: { ...inst.provenance } })
          break
        }
      }
    }
    return out
  }

  async queryInstances(type: string, cond: ConditionExpr | null): Promise<Instance[]> {
    const files = await listJsonFiles(this.instanceDir(type))
    const out: Instance[] = []
    for (const file of files) {
      const inst = await readJson<Instance>(join(this.instanceDir(type), file))
      if (!inst) continue
      if (cond && !matchesProperties(cond, inst.data)) continue
      out.push({ ...inst, data: { ...inst.data }, provenance: { ...inst.provenance } })
    }
    return out
  }

  // ── Edges ─────────────────────────────────────────────────────────────────

  async insertEdge(
    relationship: string,
    fromId: string,
    toId: string,
    // @impl S005-AC-007
    prov: Provenance,
  // @impl S005-AC-007
  ): Promise<Edge> {
    await ensureDir(this.edgeDir())
    // @impl S005-AC-007
    const existing = await this._findEdge(relationship, fromId, toId)
    if (existing) return { ...existing, provenance: { ...existing.provenance } }
    const id = randomUUID()
    const edge: Edge = {
      id,
      relationship,
      fromId,
      toId,
      provenance: { source_ref: prov.source_ref, confirmed_by: prov.confirmed_by, confirmed_at: prov.confirmed_at },
      source_ref: prov.source_ref,
      confirmed_by: prov.confirmed_by,
      confirmed_at: prov.confirmed_at,
    }
    await atomicWrite(this.edgePath(id), edge)
    return { ...edge, provenance: { ...edge.provenance } }
  }

  async deleteEdge(relationship: string, fromId: string, toId: string): Promise<void> {
    const edge = await this._findEdge(relationship, fromId, toId)
    if (!edge) throw new Error(`EDGE_NOT_FOUND: (${relationship}, ${fromId}, ${toId})`)
    await unlink(this.edgePath(edge.id))
  }

  async queryEdges(spec: EdgeQuery): Promise<Edge[]> {
    const files = await listJsonFiles(this.edgeDir())
    const out: Edge[] = []
    for (const file of files) {
      const edge = await readJson<Edge>(join(this.edgeDir(), file))
      if (!edge) continue
      if (spec.relationship !== undefined && edge.relationship !== spec.relationship) continue
      if (spec.fromId !== undefined && edge.fromId !== spec.fromId) continue
      if (spec.toId !== undefined && edge.toId !== spec.toId) continue
      out.push({ ...edge, provenance: { ...edge.provenance } })
    }
    return out
  }

  private async _findEdge(
    relationship: string,
    fromId: string,
    toId: string,
  ): Promise<Edge | null> {
    const hits = await this.queryEdges({ relationship, fromId, toId })
    return hits[0] ?? null
  }

  // ── Rules ─────────────────────────────────────────────────────────────────

  async insertRule(rule: RuleDef): Promise<void> {
    await ensureDir(this.ruleDir())
    await atomicWrite(this.rulePath(rule.id), rule)
  }

  async getRule(id: string): Promise<RuleDef | null> {
    return readJson<RuleDef>(this.rulePath(id))
  }

  async updateRule(rule: RuleDef): Promise<void> {
    await ensureDir(this.ruleDir())
    await atomicWrite(this.rulePath(rule.id), rule)
  }

  async queryRules(filter?: { appliesTo?: string; enabled?: boolean }): Promise<RuleDef[]> {
    const files = await listJsonFiles(this.ruleDir())
    const out: RuleDef[] = []
    for (const file of files) {
      const rule = await readJson<RuleDef>(join(this.ruleDir(), file))
      if (!rule) continue
      if (filter?.appliesTo !== undefined && rule.appliesTo !== filter.appliesTo) continue
      if (filter?.enabled !== undefined && rule.enabled !== filter.enabled) continue
      out.push({ ...rule })
    }
    return out
  }

  async insertRuleIfAbsent(rule: RuleDef): Promise<boolean> {
    await ensureDir(this.ruleDir())
    const existing = await readJson<RuleDef>(this.rulePath(rule.id))
    if (existing) return false
    await atomicWrite(this.rulePath(rule.id), rule)
    return true
  }

  async atomicDisableRule(id: string, prov: Provenance): Promise<'ok' | 'not_found'> {
    const rule = await this.getRule(id)
    if (!rule) return 'not_found'
    await atomicWrite(this.rulePath(id), {
      ...rule,
      enabled: false,
      version: rule.version + 1,
      source_ref: prov.source_ref,
      confirmed_by: prov.confirmed_by,
      confirmed_at: prov.confirmed_at,
    })
    return 'ok'
  }
}
