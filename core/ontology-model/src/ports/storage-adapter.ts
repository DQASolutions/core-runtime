// The contract every storage backend must satisfy (source-spec §4, ADR-0002).
// Layer 2/3 know ONLY this interface — never a concrete backend (NT1/NT2).

import type {
  ConditionExpr,
  Edge,
  Instance,
  MigrationReport,
  OntologySchema,
  Provenance,
  RuleDef,
  TraversalResult,
  TraverseSpec,
} from '../types/index.js'

export type Row = Record<string, unknown>

/** One instance in a bulk write — id resolved by the caller (deterministic for
 * ref'd instances, random otherwise), so the adapter just materialises it. */
export interface BulkInstanceRow {
  id: string
  type: string
  data: Row
/** XUẤT XỨ RIÊNG của một bản ghi — tệp/băm nội dung mà nó dẫn ra từ đó.
 *  Bỏ trống ⇒ dùng `source_ref` của cả mẻ (hành vi cũ, không đổi một byte).
 *
 *  Vì sao phải theo TỪNG bản ghi: một mẻ nạp trộn nhiều tài liệu (3.601 bút toán từ 4 sổ khác nhau).
 *  Một `source_ref` cho cả mẻ nên node chỉ ghi được chữ 'session' — tức ghi sổ mà không ghi số chứng từ:
 *  không lần ngược ra tệp gốc, và tài liệu đổi thì không biết node nào chạm. */
  sourceRef?: string
}

/** One edge in a bulk write — endpoints already resolved to instance ids. */
export interface BulkEdgeRow {
  relationship: string
  fromId: string
  toId: string
}

export interface EdgeQuery {
  relationship?: string
  fromId?: string
  toId?: string
}

/**
 * The many-endpoint form of EdgeQuery, for walking one relationship out of a
 * whole page of rows at once. Deliberately a SEPARATE type behind a separate
 * optional method rather than extra fields on EdgeQuery: an adapter that did
 * not know the new fields would ignore them and return every edge in the
 * tenant — a silent over-fetch that reads as data corruption downstream.
 * A missing method, by contrast, is visible and falls back safely.
 */
export interface MultiEdgeQuery {
  relationship?: string
  fromIds?: readonly string[]
  toIds?: readonly string[]
}

/**
 * A single atomic unit of work, shared between the state write and the EventStore
 * append so both commit or roll back together (M2). `adapter` is the tenant- and
 * transaction-scoped store the Action's effect writes through; `raw` is the
 * backend-native transaction handle (e.g. a pg PoolClient) that a same-backend
 * EventStore enlists in — absent for adapters without transaction support, in
 * which case an EventStore must fall back to its own connection / an outbox.
 */
/**
 * ⭐ DẤU CỦA ĐƠN VỊ CÔNG VIỆC THẬT — thêm 5/9/2026.
 *
 *   `UnitOfWork` là ba ô trần, nên dựng tay một vật `{ tenantId, adapter }` là
 *   qua được mọi cửa. Điều đó nguy vì `onTransactionBegin` — chỗ host đặt
 *   `SET LOCAL` cho hàng rào phạm vi theo hàng — CHỈ chạy khi adapter tự mở giao
 *   dịch. Một `uow` dựng tay không có `SET LOCAL` nào, và hậu quả là loại tệ
 *   nhất: không lỗi, không màn hình hỏng, chỉ là đơn vị này đọc được của đơn vị
 *   kia.
 *
 * ⛔ Dấu này KHÔNG phải bảo mật — ai cố tình gán vẫn gán được. Nó chặn cái NHẦM,
 *    không chặn cái CỐ Ý: một host tưởng `{ tenantId, adapter }` là đủ sẽ nhận
 *    một lời từ chối nói rõ phải lấy `uow` ở đâu, thay vì một hàng rào im lặng
 *    biến mất.
 */
export const UNIT_OF_WORK_BRAND: unique symbol = Symbol.for('@dqa-ai-solutions/ontology-sdk:unit-of-work')

export interface UnitOfWork {
  tenantId: string
  adapter: StorageAdapter
  raw?: unknown
  /** Đóng bởi `Ontology.withUnitOfWork` — xem `UNIT_OF_WORK_BRAND`. */
  readonly [UNIT_OF_WORK_BRAND]?: true
}

/**
 * Đóng dấu. Gọi bởi `Ontology.withUnitOfWork` — KHÔNG phải bởi adapter.
 *
 * ⭐ Đóng ở cửa của kernel chứ không bắt adapter đóng: dấu chỉ cần nói "`uow`
 *    này đi ra từ `withUnitOfWork`", và cửa ấy là chỗ duy nhất biết điều đó.
 *    Bắt adapter đóng là đổi hợp đồng, và mọi adapter bên thứ ba gãy.
 */
export function brandUnitOfWork(uow: Omit<UnitOfWork, typeof UNIT_OF_WORK_BRAND>): UnitOfWork {
  return Object.assign(uow, { [UNIT_OF_WORK_BRAND]: true as const })
}

/** `uow` có phải do adapter mở không. */
export const isBrandedUnitOfWork = (u: unknown): u is UnitOfWork =>
  typeof u === 'object' && u !== null && (u as Record<PropertyKey, unknown>)[UNIT_OF_WORK_BRAND] === true

/**
 * A backend-agnostic store. The adapter only persists + retrieves; ontology
 * invariants (provenance, cardinality, endpoint typing, tenant scope) are
 * enforced ABOVE it in Layer 2, which is why every adapter passes the same
 * parity suite (QG-5).
 */
export interface StorageAdapter {
  // schema
  applySchema(schema: OntologySchema): Promise<MigrationReport>

  // instances
  insertInstance(
    type: string,
    data: Row,
    prov: Provenance,
  ): Promise<Instance>
  updateInstance(id: string, patch: Row, prov: Provenance): Promise<Instance>
  /**
   * Create-or-replace an instance at a CALLER-SUPPLIED id (the seam for
   * idempotent ingest). Unlike insertInstance (which mints a random id), the id
   * is deterministic — derived from the instance's stable `ref` — so re-running
   * the same payload overwrites the same node instead of duplicating it. Replaces
   * the full `data` bag (not a partial patch) and refreshes provenance.
   */
  upsertInstance(id: string, type: string, data: Row, prov: Provenance): Promise<Instance>
  getInstance(id: string): Promise<Instance | null>
  /**
   * Batch read — OPTIONAL native override. ONE round-trip for N ids; order
   * follows `ids`, missing ids are omitted, duplicates collapse to one row.
   * When absent the API falls back to a getInstance loop, so every adapter
   * stays correct — but a backend that opens a transaction per read pays N+1
   * *transactions* on any relationship walk, which is the difference between a
   * list screen answering in milliseconds and in seconds. Implement it.
   */
  getInstances?(ids: readonly string[]): Promise<Instance[]>
  /** `cond` is the property-level filter for find(); null = all of `type`. */
  queryInstances(type: string, cond: ConditionExpr | null): Promise<Instance[]>

  // edges
  insertEdge(
    relationship: string,
    fromId: string,
    toId: string,
    prov: Provenance,
  ): Promise<Edge>
  deleteEdge(relationship: string, fromId: string, toId: string): Promise<void>
  queryEdges(spec: EdgeQuery): Promise<Edge[]>
  /**
   * Batch edge read — OPTIONAL native override. `fromIds` and `toIds` are OR'd
   * with each other and AND'd with `relationship`; empty arrays match nothing.
   * When absent the API loops queryEdges once per endpoint, which is correct
   * but is exactly the round-trip multiplication this door exists to remove.
   */
  queryEdgesMulti?(spec: MultiEdgeQuery): Promise<Edge[]>

  // Bulk write door — OPTIONAL native override for ingest. When present, the API
  // routes a whole ingest batch through these (one storage round-trip per ~1000
  // rows via UNWIND) instead of N per-item calls; when absent it falls back to
  // the per-item methods above (parity for adapters that don't optimise, e.g.
  // in-memory/filesystem in tests). Ingest is pre-validated and deterministic
  // from source docs, so these skip the per-item guard the API applies upstream.
  bulkUpsertInstances?(rows: BulkInstanceRow[], prov: Provenance): Promise<void>
  bulkCreateInstances?(rows: BulkInstanceRow[], prov: Provenance): Promise<void>
  /** Returns how many edges EXIST after the write. A row whose endpoint is missing is skipped — that is a
   *  legitimate outcome, but it must be COUNTABLE, otherwise a silent skip is indistinguishable from success. */
  bulkInsertEdges?(rows: BulkEdgeRow[], prov: Provenance): Promise<number>

  // rules (stored as data — NT4)
  insertRule(rule: RuleDef): Promise<void>
  getRule(id: string): Promise<RuleDef | null>
  updateRule(rule: RuleDef): Promise<void>
  queryRules(filter?: { appliesTo?: string; enabled?: boolean }): Promise<RuleDef[]>
  // Atomic variants — implement to prevent TOCTOU races under concurrent callers.
  // registry.ts uses these when present, falling back to the non-atomic pair above.
  insertRuleIfAbsent?(rule: RuleDef): Promise<boolean>
  atomicDisableRule?(id: string, prov: Provenance): Promise<'ok' | 'not_found'>

  /**
   * Conditional write: apply `patch` to `id` ONLY IF every key in `expected`
   * still holds its stated value. Returns false when it does not — the caller's
   * read is stale and it must recompute, not retry blindly.
   *
   * ⭐ WHY THIS BELONGS ON THE PORT AND NOT IN CALLER CODE.
   *
   *   A caller that reads, compares, then writes has an `await` between the
   *   compare and the write, and Node yields the event loop exactly there. Two
   *   concurrent requests both read the old value, both pass the check, and both
   *   write — a running total silently exceeds its own ceiling. Measured, not
   *   feared: a cascade test drives two concurrent
   *   allocations against a target with 40 left, 40 each; the userland version
   *   lets both through (640 booked against a ceiling of 600) while the ledger
   *   still reports "0 remaining".
   *
   *   A per-key lock in userland fixes one process and lies about the rest: a
   *   second process, or a second node, has its own lock table.
   *
   *   Same reason `atomicDisableRule` and `insertRuleIfAbsent` are here.
   *
   * ⚠️ `expected` compares against the STORED value, NULL included — an absent
   *    key and a key holding null are the same thing, and both match `null`.
   *
   * Optional so existing adapters keep compiling; a caller that needs the
   * guarantee must check for it and refuse the adapter that lacks it, rather
   * than falling back to read-then-write and passing its own tests anyway.
   */
  compareAndSetInstance?(
    id: string, expected: Row, patch: Row, prov: Provenance,
  ): Promise<boolean>

  // traversal — OPTIONAL native override; when absent the core planner builds
  // it from repeated queryEdges (ADR-0007).
  traverse?(spec: TraverseSpec): Promise<TraversalResult>

  // tenancy — returns an adapter scoped to one tenant's isolated store (§6).
  withTenant(tenantId: string): StorageAdapter

  // transaction — OPTIONAL. Run `fn` in a single atomic transaction; the
  // UnitOfWork it receives carries a tenant- & tx-scoped adapter (all writes
  // through it commit or roll back together) plus the backend-native handle in
  // `raw` for a co-located EventStore to enlist in. Adapters without tx support
  // omit it; the write-door then runs the effect + event-append sequentially
  // (best-effort), so the kernel works on every backend. (M2)
  withTransaction?<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T>

  // reset — DESTRUCTIVE. Remove ALL persisted data (instances, edges, rules,
  // schema snapshot) for the tenant this adapter view is scoped to, so a fresh
  // load starts from an empty store. Powers `dqa-fos reset`. Idempotent: clearing
  // an already-empty tenant is a no-op.
  clearTenant(): Promise<void>

  // lifecycle — OPTIONAL. Dispose any long-lived connection pool (Bolt driver,
  // pg Pool) so the host process can exit cleanly. Backends without a pool
  // (filesystem / in-memory) omit it. Closing a base adapter also closes the
  // shared resource of every view withTenant() handed out from it.
  close?(): Promise<void>
}
