// The Ontology Port — the SDK's PRIMARY (driving-side) contract: the single
// surface hosts and apps program against. (The adapter ports in this folder are
// the driven side — persistence.) The investigation agent's command-set IS
// this Port (`query` / `callFunction` / `applyAction`).
//
// Reconciled contract (ADR-0012): every call threads `Ctx` (tenant + actor);
// writes also carry `Provenance` (NT4). `applyAction` is the SOLE write door,
// around which a host wraps its governance interceptor chain.
//
// Conformance status: the current `Ontology` class already satisfies the
// schema / read / rule-registration subset. The kinetic methods
// (`defineAction`, `defineFunction`, `callFunction`, `applyAction`, `query`,
// and `evaluateRules → RuleResult[]`) are the M1 gap — see
// `design-kinetic-ontology.md`. This interface is the target the class migrates
// to; a host imports the type and codes against it.

import type {
  Ctx,
  Provenance,
  Instance,
  ConditionExpr,
  TraverseSpec,
  TraversalResult,
  EvalScope,
  EntityTypeDef,
  RelationshipTypeDef,
  OntologySchema,
  RuleDef,
} from '../types/index.js'
import type {
  ActionTypeDef,
  FunctionTypeDef,
  RuleResult,
  OntologyEvent,
  Args,
  Value,
  QuerySpec,
} from '../types/kinetic.js'

/** A whole ingest batch — the same shape a step's structured payload carries.
 * `ref` on an instance makes its id deterministic (idempotent re-run); links
 * reference instances by `ref` (falling back to a literal id). */
export interface IngestBulkPayload {
  instances?: Array<{ type: string; props?: Record<string, unknown>; ref?: string; sourceRef?: string }>
  links?: Array<{ relationship: string; from: string; to: string }>
}

/** Count of what an ingest batch wrote — surfaced to the caller + the coarse
 * audit entry (one per batch, not per item). */
export interface IngestBulkResult {
  instances: number
  links: number
  /**
   * Edges that EXIST after the write — deliberately distinct from `links` (how many were REQUESTED).
   * An edge whose endpoint is absent is skipped by design; the two numbers diverging is the single most
   * useful fact this call can report, and reporting only the request makes a silent skip read as success.
   */
  linked: number
}

export interface OntologyPort {
  // ── Schema / registration (called by app loaders at install) ──────────────
  getSchema(ctx: Ctx): Promise<OntologySchema>
  defineEntityType(def: EntityTypeDef, ctx: Ctx): Promise<void>
  defineRelationshipType(def: RelationshipTypeDef, ctx: Ctx): Promise<void>
  defineAction(def: ActionTypeDef, ctx: Ctx): Promise<void>
  defineFunction(def: FunctionTypeDef, ctx: Ctx): Promise<void>

  // ── Reads = command-set (step executors · agent · on-demand API) ───────────
  get(id: string, ctx: Ctx): Promise<Instance | null>
  find(type: string, where: ConditionExpr | undefined, ctx: Ctx): Promise<Instance[]>
  neighbors(id: string, relationship: string | undefined, ctx: Ctx): Promise<Instance[]>
  /** neighbors() for a page of rows — ONE edge read + ONE instance read for all
   *  starts. Prefer this whenever decorating a list; the per-id form in a loop
   *  costs a round-trip (and, on transactional adapters, a transaction) per row. */
  neighborsOf(
    ids: readonly string[],
    relationship: string | undefined,
    ctx: Ctx,
  ): Promise<Map<string, Instance[]>>
  traverse(spec: TraverseSpec, ctx: Ctx): Promise<TraversalResult>
  query(spec: QuerySpec, ctx: Ctx): Promise<Instance[]>
  callFunction(name: string, args: Args, ctx: Ctx): Promise<Value>

  // ── Write = the SOLE governed door (guarded · provenanced · emits events) ──
  // `uow` — chạy trong giao dịch bên gọi ĐÃ mở, để host ghép một phép đọc-rồi-ghi
  // của mình vào cùng giao dịch với hiệu ứng. Lấy nó từ `withUnitOfWork`, đừng tự
  // mở: hook đặt hàng rào phạm vi chỉ bắn khi adapter mở giao dịch.
  applyAction(
    name: string, params: Args, prov: Provenance, ctx: Ctx, uow?: unknown,
  ): Promise<OntologyEvent[]>

  // Một đơn vị công việc để ghép nhiều lượt ghi — và một chỗ chạy SQL riêng của
  // host (`uow.raw`) nằm cùng giao dịch ấy.
  withUnitOfWork?<T>(fn: (uow: unknown) => Promise<T>, ctx?: Ctx): Promise<T>

  // Bulk write door for ingest — materialises a whole batch (deterministic ids,
  // UNWIND-backed when the adapter supports it), pre-validated once by the
  // caller. Emits ONE coarse audit entry for the batch rather than per item:
  // ingest is bulk-machine work, deterministic from source docs, so the source
  // files + the resulting graph are the audit evidence. Human writes still go
  // through applyAction (full per-action guard + audit).
  ingestBulk(payload: IngestBulkPayload, prov: Provenance, ctx: Ctx): Promise<IngestBulkResult>

  // ── Rules (pure · neutral output) ──────────────────────────────────────────
  registerRule(def: RuleDef, ctx: Ctx): Promise<void>
  evaluateRules(scope: EvalScope): Promise<RuleResult[]>
}
