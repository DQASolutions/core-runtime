// Layer 3 — the public Ontology facade. The only surface consumers call. Speaks
// pure ontology (entity / relationship / rule / traverse / context); never SQL.
// Enforces provenance (NT3), tenant scope (§6), endpoint typing (BR-005) and
// cardinality (BR-006) above the adapter, then delegates persistence to it.

import {
  type ContextBundle,
  type Edge,
  type EvalScope,
  type EntityTypeDef,
  type Flag,
  type Instance,
  type MigrationReport,
  type OntologySchema,
  type Provenance,
  type RelationshipTypeDef,
  type RuleDef,
  type RuleKind,
  type TraversalResult,
  type TraverseSpec,
  type Ctx,
  isCompleteProvenance,
  ontologyError,
} from '../types/index.js'
import type { ConditionExpr } from '../types/index.js'
import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import type {
  BulkEdgeRow,
  BulkInstanceRow,
  MultiEdgeQuery,
  Row,
  StorageAdapter,
  UnitOfWork,
} from '../ports/storage-adapter.js'
import { brandUnitOfWork, isBrandedUnitOfWork } from '../ports/storage-adapter.js'
import type { EventStore } from '../ports/event-store.js'
import { NullEventStore } from '../adapters/event-store/null-event-store.js'
import type { EmbedFn, VectorAdapter } from '../ports/vector-adapter.js'
import { SchemaRegistry } from '../core/schema/schema-registry.js'
import { validateInstanceData } from '../core/graph/validation.js'
import { idFor } from '../shared/deterministic-id.js'
import { validateCondition, evaluateRuleCondition } from '../core/rules/condition-interpreter.js'
import { planTraversal } from '../core/graph/traversal-planner.js'
import {
  breakingChanges,
  formatBreakingChanges,
  schemaSurface,
  type SchemaSurface,
} from '../core/schema/surface.js'
import { disableRule, listRules, registerRule } from '../core/rules/registry.js'
import { evaluateRules } from '../core/rules/evaluate.js'
import { retrieveContext, type ContextOpts } from '../core/context/retrieve.js'
import {
  ActionRegistry,
  runAction,
  builtinActions,
  type ActionImpl,
  type ActionIO,
} from '../core/actions/action-runtime.js'
import {
  FunctionRegistry,
  functionCacheKey,
  type FunctionImpl,
  type FunctionIO,
} from '../core/functions/function-runtime.js'
import type { ActionTypeDef, FunctionTypeDef, OntologyEvent, RuleResult, QuerySpec, Args, Value } from '../types/index.js'
import type { IngestBulkPayload, IngestBulkResult, OntologyPort } from '../ports/ontology-port.js'

export interface OntologyDeps {
  adapter: StorageAdapter
  vector?: VectorAdapter
  embed?: EmbedFn
  /** Durable change log (M2). Omit only for ephemeral/dev runs — absence is logged,
   *  never silent (ADR — event store). Defaults to NullEventStore (no persistence). */
  eventStore?: EventStore
  /**
   * Whether the primitive writes — create / upsert / update / link / unlink —
   * may be called directly, outside an Action.
   *
   * `'open'` (default, and the behaviour that has always existed) allows it.
   *
   * `'actions-only'` refuses. Reach for it when the audit trail has to be
   * complete: only `applyAction()` records an event, so a direct `create()`
   * changes state with nothing in the change log — the record moves and the
   * ledger says it never did. That is invisible at the call site, which is why
   * apps that care end up writing their own linter to forbid it. This turns
   * that convention into a runtime refusal.
   *
   * Bootstrapping and fixture loading legitimately write outside an Action;
   * wrap those in {@link Ontology.asBootstrap} so the exemption is written
   * down at the place it is taken, and greppable.
   */
  writeGate?: 'open' | 'actions-only'
}

export interface MigrateOptions {
  /**
   * The surface last applied. Given, migrate() refuses a change that would
   * strand stored events — a removal, a rename, a narrowed type, a dropped
   * enum value, a moved relationship endpoint.
   *
   * The kernel decides what counts as breaking; where the baseline is kept is
   * the app's business (a checked-in lock file is the usual answer). Omit it
   * and migrate() behaves exactly as it always has.
   */
  baseline?: SchemaSurface
  /**
   * Apply the change anyway. Deliberately a per-call argument and not a
   * setting: overriding this guarantee should appear in the diff of the commit
   * that overrides it.
   */
  acceptBreaking?: boolean
}

/** Returns true if any node in the ConditionExpr tree requires edge resolution (FR-X04). */
function hasRelationshipOp(expr: ConditionExpr): boolean {
  switch (expr.op) {
    case 'exists':
    case 'absent':
    case 'count':
      return true
    case 'and':
    case 'or':
      return expr.clauses.some(hasRelationshipOp)
    case 'not':
      return hasRelationshipOp(expr.clause)
    default:
      return false
  }
}

/**
 * The write-gate scope — ONE AsyncLocalStorage for the process, never one per
 * Ontology.
 *
 * ⛔ It used to be a per-instance field, and apps build an Ontology per request.
 *    On Node ≤ 22 an AsyncLocalStorage that has ever `run()` joins a global list
 *    that every new promise walks, and it never leaves without `disable()` —
 *    which no instance can safely call, since it cannot know it is done. So each
 *    write request added a storage forever: measured on node:22, 5,000 of them
 *    made every `await` ~330× slower and the heap grew 4 → 48 MB. Node 24
 *    (AsyncContextFrame) hides it, which is why a dev machine never saw it.
 *
 * The usual pattern for async context: declare the variable once, put the
 * per-scope value in the store. The store is the SET of instances whose door is
 * open in this call stack, so an action on one Ontology still opens no door on
 * another — and a scope nested inside another instance's keeps the outer one
 * open, exactly as separate storages did.
 */
type WriteScope = ReadonlyMap<Ontology, 'action' | 'bootstrap'>
const writeScope = new AsyncLocalStorage<WriteScope>()

function enterWriteScope<T>(owner: Ontology, reason: 'action' | 'bootstrap', fn: () => Promise<T>): Promise<T> {
  const open = new Map(writeScope.getStore() ?? [])
  open.set(owner, reason)
  return writeScope.run(open, fn)
}

export class Ontology implements OntologyPort {
  private readonly adapter: StorageAdapter
  private readonly vector?: VectorAdapter
  private readonly embed?: EmbedFn
  // Durable change log (M2). Defaults to NullEventStore; absence warned, not silent.
  private readonly eventStore: EventStore
  // Schema is per-tenant; the registry caches it for Layer-2 validation.
  private readonly registries = new Map<string, SchemaRegistry>()
  // Action runtime — per-tenant registry, seeded with the built-in write verbs.
  private readonly actionRegistries = new Map<string, ActionRegistry>()
  // Function runtime — per-tenant registry + a per-tenant memo cache cleared on
  // any write (Functions are pure given the graph state).
  private readonly functionRegistries = new Map<string, FunctionRegistry>()
  private readonly functionCaches = new Map<string, Map<string, Value>>()

  private readonly writeGate: 'open' | 'actions-only'
  /**
   * Marks the call stack that is allowed to write primitively.
   *
   * AsyncLocalStorage rather than a depth counter on purpose: a counter set
   * before an await and cleared after would also be set for anything else
   * running concurrently, so a stray direct write would slip through whenever
   * an Action happened to be in flight. The gate would then hold or not hold
   * depending on timing — the worst possible property for a rule about the
   * audit trail.
   *
   * ONE storage for the whole process, shared by every instance — see
   * {@link writeScope} at module level. The store names the open instances, so the
   * gate stays per instance.
   */

  constructor(deps: OntologyDeps) {
    this.adapter = deps.adapter
    if (deps.vector) this.vector = deps.vector
    if (deps.embed) this.embed = deps.embed
    this.writeGate = deps.writeGate ?? 'open'
    if (deps.eventStore) {
      this.eventStore = deps.eventStore
    } else {
      // ADR: never silently. Domain events are not persisted without a store.
      console.warn('[ontology] No EventStore configured — domain events are NOT persisted (NullEventStore).')
      this.eventStore = new NullEventStore()
    }
  }

  /** Run `fn` in the scope where primitive writes are permitted. */
  private governed<T>(fn: () => Promise<T>): Promise<T> {
    return enterWriteScope(this, 'action', fn)
  }

  /**
   * Run `fn` with the write gate lifted — for provisioning and fixtures, which
   * legitimately create state that no Action produced.
   *
   * Deliberately a wrapper rather than a constructor flag: the exemption is
   * then written at the place it is taken, and one grep finds every place that
   * writes outside the audit trail. A flag set once at start-up exempts the
   * whole process and nobody can see where it mattered.
   *
   * No-op when `writeGate` is `'open'`.
   */
  asBootstrap<T>(fn: () => Promise<T>): Promise<T> {
    return enterWriteScope(this, 'bootstrap', fn)
  }

  /**
   * Refuse a primitive write made outside an Action when the gate is closed.
   *
   * Why this is worth refusing: only `applyAction()` appends to the change log.
   * A direct write therefore moves state while the ledger shows nothing — and
   * an event stream with holes cannot be replayed, reconciled or audited. The
   * failure is silent by construction, so it has to be refused at the door.
   */
  private assertWriteAllowed(op: string): void {
    if (this.writeGate === 'open') return
    if (writeScope.getStore()?.has(this)) return
    throw ontologyError(
      'WRITE_OUTSIDE_ACTION',
      `${op}() was called directly while writeGate is "actions-only". Primitive ` +
        'writes do not emit events, so this change would never reach the change ' +
        'log. Route it through applyAction(), or wrap provisioning in asBootstrap().',
    )
  }

  // @impl BR-012, BR-015
  private tenant(ctx: Ctx): string {
    const id = ctx?.tenantId
    if (typeof id !== 'string' || id.trim().length === 0) {
      throw ontologyError('TENANT_MISMATCH', 'ctx.tenantId is required and must be non-empty')
    }
    return id
  }

  private reg(tenantId: string): SchemaRegistry {
    let r = this.registries.get(tenantId)
    if (!r) {
      r = new SchemaRegistry()
      this.registries.set(tenantId, r)
    }
    return r
  }
// @impl BR-001

  // @impl BR-001
  private requireProvenance(p: Provenance, op: string): void {
    if (!isCompleteProvenance(p)) {
      throw ontologyError('PROVENANCE_MISSING', `${op} requires provenance (source_ref + confirmed_by + confirmed_at)`)
    }
  }

  // @impl S001-AC-006, S001-AC-010
  // ── Schema ────────────────────────────────────────────────────────────────
// @impl S001-AC-006, S001-AC-010

  // @impl BR-002, BR-003, BR-007, S001-AC-001, S001-AC-002, S001-AC-006, S001-AC-010
  async defineEntityType(def: EntityTypeDef, ctx: Ctx): Promise<void> {
    // @impl S002-AC-006, S002-AC-010
    this.reg(this.tenant(ctx)).defineEntityType(def)
  }
// @impl S002-AC-006, S002-AC-010, S003-AC-005

  // @impl BR-004, BR-005, BR-006, S002-AC-001, S002-AC-002, S002-AC-006, S002-AC-007, S002-AC-010, S003-AC-005
  async defineRelationshipType(def: RelationshipTypeDef, ctx: Ctx): Promise<void> {
    this.reg(this.tenant(ctx)).defineRelationshipType(def)
  }

  // ── Actions (kinetic write layer) ───────────────────────────────────────────

  /** Per-tenant action registry, lazily seeded with the built-in write verbs. */
  private actionReg(tenantId: string): ActionRegistry {
    let r = this.actionRegistries.get(tenantId)
    if (!r) {
      r = new ActionRegistry()
      for (const impl of builtinActions()) r.define(impl)
      this.actionRegistries.set(tenantId, r)
    }
    return r
  }

  /** The governed primitive-write surface an effect runs through (carries prov+ctx).
   *  `adapter`, when supplied, is the tenant- & tx-scoped store the writes route
   *  through so the whole effect commits atomically (M2). */
  private makeActionIO(prov: Provenance, ctx: Ctx, adapter?: StorageAdapter): ActionIO {
    return {
      create: async (entityType, data) => ({ id: (await this.create(entityType, data, prov, ctx, adapter)).id }),
      upsert: async (entityType, ref, data) => ({ id: (await this.upsert(entityType, ref, data, prov, ctx, adapter)).id }),
      update: async (id, patch) => ({ id: (await this.update(id, patch, prov, ctx, adapter)).id }),
      link: async (relationship, fromId, toId) => {
        await this.link(relationship, fromId, toId, prov, ctx, adapter)
      },
      unlink: async (relationship, fromId, toId) => {
        await this.unlink(relationship, fromId, toId, prov, ctx, adapter)
      },
    }
  }

  /** Register an Action *signature* (Port contract). Body is bound separately. */
  async defineAction(def: ActionTypeDef, ctx: Ctx): Promise<void> {
    this.actionReg(this.tenant(ctx)).declare(def)
  }

  /** SPI: bind an Action's guard + effect body (app-supplied). */
  async defineActionImpl(impl: ActionImpl, ctx: Ctx): Promise<void> {
    this.actionReg(this.tenant(ctx)).define(impl)
  }

  /**
   * The sole governed write door: run an Action's guard (submission-criteria),
   * execute its effect through the provenanced IO surface, return the emitted
   * events. `createInstance` / `updateInstance` / `link` are built in.
   */
  /**
   * ⭐ `uow` — CHẠY TRONG GIAO DỊCH DO BÊN GỌI ĐÃ MỞ. Thêm 5/9/2026.
   *
   *   Không có nó thì mỗi lượt ghi là một giao dịch riêng, và host KHÔNG THỂ
   *   ghép một phép đọc-rồi-ghi của mình vào cùng giao dịch với hiệu ứng. Chỗ
   *   ấy đo được ở app tham chiếu: đường chia chỉ tiêu đọc tổng đã chia trên
   *   một lượt rồi ghi ở lượt khác; hai người chia cùng lúc thì cả hai qua cửa
   *   và chỉ tiêu 500 bị chia 600. Bịt bằng so-rồi-đặt thì phép so và phép ghi
   *   BẮT BUỘC phải cùng một giao dịch — mà cửa ghi lại tự mở giao dịch riêng.
   *
   * ⛔ ĐỪNG TỰ MỞ GIAO DỊCH RỒI ĐƯA CLIENT VÀO ĐÂY. Lấy `uow` từ
   *    {@link Ontology.withUnitOfWork}: adapter mở giao dịch nên
   *    `onTransactionBegin` — chỗ host đặt `SET LOCAL` cho hàng rào theo hàng —
   *    CHẮC CHẮN đã chạy. Client tự mở thì hook ấy không bắn, và hàng rào biến
   *    mất lặng lẽ ở đúng lượt ghi. Đó là lý do tham số này nhận `UnitOfWork`
   *    chứ không nhận một client thô.
   */
  async applyAction(
    name: string, params: Args, prov: Provenance, ctx: Ctx, uow?: UnitOfWork,
  ): Promise<OntologyEvent[]> {
    this.requireProvenance(prov, `applyAction(${name})`)
    const tid = this.tenant(ctx)
    const impl = this.actionReg(tid).get(name)
    if (!impl) throw ontologyError('ACTION_NOT_FOUND', `Unknown action "${name}"`)
    const base = this.adapter.withTenant(tid)
    // The write-door unit of work: run the effect AND append its events together.
    // On a tx-capable adapter both commit atomically; otherwise sequential
    // best-effort (M2). The EventStore is the version authority on append.
    const run = async (uow: UnitOfWork): Promise<OntologyEvent[]> => {
      // Inside this scope the primitive writes are permitted even under
      // writeGate:'actions-only' — this IS the governed door.
      const raw = await this.governed(() =>
        runAction(impl, params, ctx, this.makeActionIO(prov, ctx, uow.adapter)),
      )
      // ⭐ Đóng dấu TÊN BƯỚC lên mọi sự kiện của lượt ghi này.
      //
      //   Hiệu ứng không tự khai được — nó chỉ biết mình đang chạy, không biết
      //   mình được gọi dưới tên bước nào. Cửa ghi thì biết chắc. Nhờ dấu này,
      //   phát lại nhật ký qua đồ thị quy trình không phải đoán theo quy ước
      //   đặt tên `type` nữa.
      //
      // ⚠️ Đóng dấu TRƯỚC khi `append`, để tên bước nằm trong chuỗi băm — sửa
      //    tên bước về sau là gãy chuỗi, đúng như mọi trường khác của sự kiện.
      const events = raw.map((e) => (e.action ? e : { ...e, action: name }))
      await this.eventStore.append(events, uow)
      return events
    }
    // Giao dịch của bên gọi thì dùng luôn — KHÔNG mở lồng thêm một cái nữa.
    if (uow) {
      /* ⛔ CHỈ NHẬN `uow` DO ADAPTER MỞ. Một vật `{ tenantId, adapter }` dựng tay
         cũng khớp kiểu, nhưng nó chưa chạy `onTransactionBegin` — chỗ host đặt
         `SET LOCAL` cho hàng rào phạm vi theo hàng. Nhận bừa là hàng rào biến
         mất đúng ở lượt ghi, không lỗi, không màn hình hỏng, chỉ là đơn vị này
         đọc được của đơn vị kia. Từ chối, và nói rõ lấy `uow` ở đâu. */
      if (!isBrandedUnitOfWork(uow)) {
        throw ontologyError('MIGRATION_FAILED',
          'The unit of work was not opened by the adapter. Obtain it from withUnitOfWork() — '
          + 'a hand-built one has not run onTransactionBegin, so row-level scope would be silently absent.')
      }
      return run(uow)
    }
    return base.withTransaction
      ? base.withTransaction(run)
      : run({ tenantId: tid, adapter: base })
  }

  /**
   * Mở MỘT đơn vị công việc, trao ra để bên gọi ghép nhiều lượt ghi vào cùng nó.
   *
   * ⭐ VÌ SAO CỬA NÀY DO KERNEL MỞ, KHÔNG PHẢI HOST TỰ MỞ: `onTransactionBegin`
   *    là chỗ host đặt `SET LOCAL` cho hàng rào phạm vi theo hàng, và nó CHỈ
   *    bắn khi adapter tự mở giao dịch. Host tự `pool.connect()` rồi `BEGIN` là
   *    hàng rào không được đặt — không lỗi, không màn hình hỏng, chỉ là xã này
   *    đọc được của xã kia. Mở hộ ở đây thì cái bẫy ấy không tồn tại.
   *
   * ⚠️ `uow.raw` là client thật của giao dịch — host chạy SQL riêng của mình
   *    trên đó (so-rồi-đặt, khoá hàng…) và nó nằm cùng giao dịch với hiệu ứng.
   *
   * Adapter không có giao dịch thì vẫn chạy, chỉ là không nguyên tử — cùng lối
   * lùi với `applyAction`.
   */
  async withUnitOfWork<T>(fn: (uow: UnitOfWork) => Promise<T>, ctx?: Ctx): Promise<T> {
    const tid = this.tenant(ctx as Ctx)
    const base = this.adapter.withTenant(tid)
    /* ⭐ ĐÓNG DẤU Ở CỬA NÀY, KHÔNG BẮT ADAPTER ĐÓNG.
       Dấu nói đúng một điều: "`uow` này đi ra từ `withUnitOfWork`", tức là
       adapter đã mở giao dịch và `onTransactionBegin` đã chạy. Đóng ở đây thì
       mọi adapter — kể cả của bên thứ ba, kể cả cái không có `withTransaction`
       — chạy nguyên như cũ; nếu bắt adapter tự đóng thì đó là đổi hợp đồng và
       mọi adapter ngoài gói này gãy. */
    const mark = <T,>(u: UnitOfWork, run: (x: UnitOfWork) => Promise<T>) => run(brandUnitOfWork(u))
    return base.withTransaction
      ? base.withTransaction((u) => mark(u, fn))
      : mark({ tenantId: tid, adapter: base }, fn)
  }

  // ── Functions (pure named compute) ──────────────────────────────────────────

  private functionReg(tenantId: string): FunctionRegistry {
    let r = this.functionRegistries.get(tenantId)
    if (!r) {
      r = new FunctionRegistry()
      this.functionRegistries.set(tenantId, r)
    }
    return r
  }

  /** Read-only graph surface a Function body runs against (no writes — purity). */
  private makeFunctionIO(ctx: Ctx): FunctionIO {
    return {
      get: (id) => this.get(id, ctx),
      find: (type, where) => this.find(type, where, ctx),
      neighbors: (id, relationship) => this.neighbors(id, relationship, ctx),
      traverse: (spec) => this.traverse(spec, ctx),
    }
  }

  /** Register a Function *signature* (Port contract). Body is bound separately. */
  async defineFunction(def: FunctionTypeDef, ctx: Ctx): Promise<void> {
    this.functionReg(this.tenant(ctx)).declare(def)
  }

  /** SPI: bind a Function's pure body (app-supplied). */
  async defineFunctionImpl(impl: FunctionImpl, ctx: Ctx): Promise<void> {
    this.functionReg(this.tenant(ctx)).define(impl)
  }

  /**
   * Call a named pure Function over the graph. Memoized per (tenant, name,
   * args); the cache is cleared on any write (create/update/link/unlink).
   */
  async callFunction(name: string, args: Args, ctx: Ctx): Promise<Value> {
    const tid = this.tenant(ctx)
    const impl = this.functionReg(tid).get(name)
    if (!impl) throw ontologyError('FUNCTION_NOT_FOUND', `Unknown function "${name}"`)

    const key = functionCacheKey(name, args)
    let cache = this.functionCaches.get(tid)
    if (cache?.has(key)) return cache.get(key) as Value

    const result = await impl.body(args, ctx, this.makeFunctionIO(ctx))
    if (!cache) {
      cache = new Map<string, Value>()
      this.functionCaches.set(tid, cache)
    }
    cache.set(key, result)
    return result
  }
// @impl S002-AC-007

  // @impl S001-AC-001, S002-AC-001, S002-AC-007, S003-AC-001, S003-AC-002, S003-AC-006, S003-AC-010
  async getSchema(ctx: Ctx): Promise<OntologySchema> {
    // @impl S003-AC-009
    return this.reg(this.tenant(ctx)).getSchema()
  }
// @impl S003-AC-001, S003-AC-002, S003-AC-006, S003-AC-010

  // @impl S003-AC-001, S003-AC-002, S003-AC-006, S003-AC-009, S003-AC-010
  async migrate(ctx: Ctx, opts?: MigrateOptions): Promise<MigrationReport> {
    const tid = this.tenant(ctx)
    // Additive-only gate. Runs BEFORE the adapter is touched: a schema that
    // would strand stored events must not be half-applied first.
    if (opts?.baseline !== undefined && opts.acceptBreaking !== true) {
      const changes = breakingChanges(opts.baseline, schemaSurface(this.reg(tid).getSchema()))
      if (changes.length > 0) {
        throw ontologyError(
          'BREAKING_SCHEMA_CHANGE',
          'Schema change is not additive — stored events would stop decoding:\n' +
            `${formatBreakingChanges(changes)}\n` +
            'Add instead of altering, or pass acceptBreaking:true deliberately.',
          { changes },
        )
      }
    }
    // FR-E03: reject immediately if no adapter is wired (belt-and-suspenders; constructor requires it,
    // but guard against explicit null/undefined injection at runtime).
    if (!this.adapter) {
      throw ontologyError('MIGRATION_FAILED', 'No StorageAdapter configured; cannot migrate')
    }
    // FR-D04: capture a schema snapshot before delegating (changes after this point are not included).
    const schema = this.reg(tid).getSchema()
    try {
      return await this.adapter.withTenant(tid).applySchema(schema)
    // @impl BR-013
    } catch (err) {
      // FR-N07 / NFR-S01: wrap adapter rejections without leaking raw backend messages
      // (Postgres DDL strings, connection details, driver internals, etc.) above Layer 3.
      // Only expose a generic sentinel message; the original error is swallowed here.
      // ⭐ THÔNG ĐIỆP vẫn chung chung — KHÔNG rò ruột adapter ra lời báo. Nhưng
      //    NGUYÊN NHÂN nay đi kèm ở `cause`, sửa 5/9/2026.
      //
      //    Hai thứ ấy khác nhau, và trước đây bị gộp làm một. BR-013 cấm để câu
      //    SQL, chuỗi kết nối, ruột driver lọt vào THÔNG ĐIỆP mà một client đọc
      //    được — đúng, giữ nguyên. Nó không cấm giữ lại nguyên nhân cho người
      //    vận hành đang đứng trước máy: `cause` là một ô lập trình, không nằm
      //    trong `message`, và ai đọc được nó thì đã ở trong tiến trình rồi.
      //
      // ⛔ ĐO ĐƯỢC CÁI GIÁ: 5/9/2026 `applySchema` hỏng vì một cột thiếu ở bảng
      //    siêu dữ liệu của chính SDK. Lời báo duy nhất là "the storage adapter
      //    rejected the schema apply operation" — không bảng, không cột, không
      //    câu SQL. Hai phiên mất một buổi tối, và phải bọc `applySchema` bằng
      //    một tệp riêng mới moi ra được câu thật.
      // @impl BR-013, S004-AC-001, S004-AC-002, S004-AC-005, S004-AC-006, S004-AC-009, S004-AC-010, S004-AC-011
      throw ontologyError(
        'MIGRATION_FAILED',
        'Migration failed: the storage adapter rejected the schema apply operation',
        { cause: err },
      )
    // @impl S006-AC-009
    }
  }

  // ── Instances ───────────────────────────────────────────────────────────────
// @impl S004-AC-001, S004-AC-002, S004-AC-005, S004-AC-006, S004-AC-009, S004-AC-010, S004-AC-011

  // @impl BR-001, S004-AC-001, S004-AC-002, S004-AC-005, S004-AC-006, S004-AC-009, S004-AC-010, S004-AC-011, S006-AC-009
  async create(
    entityType: string,
    data: Record<string, unknown>,
    prov: Provenance,
    ctx: Ctx,
    adapter?: StorageAdapter,
  ): Promise<Instance> {
    this.assertWriteAllowed('create')
    this.requireProvenance(prov, 'create')
    const tid = this.tenant(ctx)
    this.functionCaches.delete(tid) // writes invalidate pure-Function memo cache
    const et = this.reg(tid).requireEntityType(entityType)
    validateInstanceData(et, data, { partial: false })
    const a = adapter ?? this.adapter.withTenant(tid)
    return a.insertInstance(entityType, data, prov)
  }

  /**
   * Idempotent create-or-replace keyed on a stable business `ref`. The instance
   * id is DERIVED deterministically from (tenant, entityType, ref), so applying
   * the same ref again overwrites the same node rather than minting a duplicate
   * — the seam that lets an interrupted or repeated ingest converge. Validates
   * the full `data` against the schema exactly like create().
   */
  async upsert(
    entityType: string,
    ref: string,
    data: Record<string, unknown>,
    prov: Provenance,
    ctx: Ctx,
    adapter?: StorageAdapter,
  ): Promise<Instance> {
    this.assertWriteAllowed('upsert')
    this.requireProvenance(prov, 'upsert')
    const tid = this.tenant(ctx)
    if (typeof ref !== 'string' || ref.trim().length === 0) {
      throw ontologyError('REQUIRED_PROPERTY_MISSING', 'upsert requires a non-empty ref')
    }
    this.functionCaches.delete(tid) // writes invalidate pure-Function memo cache
    const et = this.reg(tid).requireEntityType(entityType)
    validateInstanceData(et, data, { partial: false })
    const id = idFor(tid, entityType, ref)
    const a = adapter ?? this.adapter.withTenant(tid)
    return a.upsertInstance(id, entityType, data, prov)
  }

  /**
   * Bulk-materialise a whole ingest batch. Validates every instance against its
   * entity type (same guard as create/upsert), resolves ids — deterministic for
   * ref'd instances (idempotent re-run), random otherwise — then writes via the
   * adapter's UNWIND bulk door when present, or a per-item fallback for adapters
   * that don't optimise (in-memory/filesystem tests). Links resolve endpoints
   * through the ref→id map (falling back to a literal id), mirroring the
   * per-item executor's `ids[from] ?? from`. Governance wraps this with ONE
   * coarse audit entry — no per-item ledger writes.
   */
  /** Provenance của MỘT dòng: `sourceRef` riêng thắng `source_ref` của cả mẻ. Dùng cho đường dự phòng
   *  (adapter chưa có bulk*) — đường bulk truyền `sourceRef` thẳng xuống Cypher. */
  private rowProvOf(prov: Provenance, row: { sourceRef?: string }): Provenance {
    return row.sourceRef ? { ...prov, source_ref: row.sourceRef } : prov
  }

  async ingestBulk(payload: IngestBulkPayload, prov: Provenance, ctx: Ctx): Promise<IngestBulkResult> {
    this.requireProvenance(prov, 'ingestBulk')
    const tid = this.tenant(ctx)
    this.functionCaches.delete(tid) // writes invalidate pure-Function memo cache
    const reg = this.reg(tid)
    const a = this.adapter.withTenant(tid)

    const instances = payload.instances ?? []
    const links = payload.links ?? []

    const refToId: Record<string, string> = {}
    const upsertRows: BulkInstanceRow[] = []
    const createRows: BulkInstanceRow[] = []
    for (const inst of instances) {
      const et = reg.requireEntityType(inst.type)
      const data = (inst.props ?? {}) as Row
      validateInstanceData(et, data, { partial: false })
      if (typeof inst.ref === 'string' && inst.ref.length > 0) {
        const id = idFor(tid, inst.type, inst.ref)
        refToId[inst.ref] = id
        upsertRows.push({ id, type: inst.type, data, ...(inst.sourceRef ? { sourceRef: inst.sourceRef } : {}) })
      } else {
        createRows.push({ id: randomUUID(), type: inst.type, data, ...(inst.sourceRef ? { sourceRef: inst.sourceRef } : {}) })
      }
    }

    const edgeRows: BulkEdgeRow[] = links.map((l) => ({
      relationship: l.relationship,
      fromId: refToId[l.from] ?? l.from,
      toId: refToId[l.to] ?? l.to,
    }))

    // `linked` = edges that EXIST after the write. This is deliberately distinct from `links` (how many were
    // REQUESTED): an edge whose endpoint is absent is skipped by design, and the two numbers diverging is the
    // single most useful fact this call can report. Reporting only the request — as this function used to —
    // makes a silent skip read as success, which is how five separate edge failures went unnoticed in one day
    // on real data.
    let linked = 0
    if (a.bulkUpsertInstances && a.bulkCreateInstances && a.bulkInsertEdges) {
      if (upsertRows.length > 0) await a.bulkUpsertInstances(upsertRows, prov)
      if (createRows.length > 0) await a.bulkCreateInstances(createRows, prov)
      if (edgeRows.length > 0) linked = await a.bulkInsertEdges(edgeRows, prov)
    } else {
      // Parity fallback — non-ref createRows are never link endpoints, so minting
      // a fresh id in insertInstance (ignoring createRows.id) is safe.
      for (const r of upsertRows) await a.upsertInstance(r.id, r.type, r.data, this.rowProvOf(prov, r))
      for (const r of createRows) await a.insertInstance(r.type, r.data, this.rowProvOf(prov, r))
      // Per-item path throws ENDPOINT_NOT_FOUND instead of skipping, so a completed loop means all landed.
      for (const e of edgeRows) await a.insertEdge(e.relationship, e.fromId, e.toId, prov)
      linked = edgeRows.length
    }
    return { instances: instances.length, links: links.length, linked }
  }

  // @impl S004-AC-001, BR-001
  async update(
    id: string,
    patch: Record<string, unknown>,
    prov: Provenance,
    ctx: Ctx,
    adapter?: StorageAdapter,
  ): Promise<Instance> {
    this.assertWriteAllowed('update')
    this.requireProvenance(prov, 'update')
    const tid = this.tenant(ctx)
    this.functionCaches.delete(tid)
    const a = adapter ?? this.adapter.withTenant(tid)
    const existing = await a.getInstance(id)
    if (!existing) throw ontologyError('INSTANCE_NOT_FOUND', `Instance "${id}" not found`)
    const et = this.reg(tid).requireEntityType(existing.entityType)
    validateInstanceData(et, patch, { partial: true })
    return a.updateInstance(id, patch, prov)
  }

  // @impl S004-AC-001
  async get(id: string, ctx: Ctx): Promise<Instance | null> {
    return this.adapter.withTenant(this.tenant(ctx)).getInstance(id)
  }

  // @impl S004-AC-001
  async find(entityType: string, where: ConditionExpr | undefined, ctx: Ctx): Promise<Instance[]> {
    const tid = this.tenant(ctx)
    this.reg(tid).requireEntityType(entityType)
    if (where) validateCondition(where)
    const a = this.adapter.withTenant(tid)
    // FR-X04: when where contains relationship-level ops (exists/absent/count),
    // fall back to per-instance evaluation via evaluateRuleCondition which
    // resolves edges via StorageAdapter.queryEdges.
    if (where && hasRelationshipOp(where)) {
      const all = await a.queryInstances(entityType, null)
      const result = []
      for (const inst of all) {
        if (await evaluateRuleCondition(where, inst, a)) result.push(inst)
      // @impl S005-AC-001, S005-AC-002, S005-AC-003, S005-AC-005, S005-AC-006, S005-AC-009, S005-AC-010, S005-AC-013, S005-AC-014
      }
      return result
    // @impl S006-AC-009
    }
    return a.queryInstances(entityType, where ?? null)
  }

  // ── Edges ─────────────────────────────────────────────────────────────────
// @impl S005-AC-001, S005-AC-002, S005-AC-003, S005-AC-005, S005-AC-006, S005-AC-009, S005-AC-010, S005-AC-013, S005-AC-014

  // @impl BR-001, BR-005, BR-006, S005-AC-001, S005-AC-002, S005-AC-003, S005-AC-005, S005-AC-006, S005-AC-009, S005-AC-010, S005-AC-013, S005-AC-014, S006-AC-009
  async link(
    relationship: string,
    fromId: string,
    toId: string,
    prov: Provenance,
    ctx: Ctx,
    adapter?: StorageAdapter,
  ): Promise<Edge> {
    // @impl BR-005
    this.assertWriteAllowed('link')
    this.requireProvenance(prov, 'link')
    const tid = this.tenant(ctx)
    this.functionCaches.delete(tid)
    const a = adapter ?? this.adapter.withTenant(tid)
    const rt = this.reg(tid).requireRelationshipType(relationship)

    const from = await a.getInstance(fromId)
    if (!from) throw ontologyError('INSTANCE_NOT_FOUND', `from instance "${fromId}" not found`)
    const to = await a.getInstance(toId)
    // @impl BR-005
    if (!to) throw ontologyError('INSTANCE_NOT_FOUND', `to instance "${toId}" not found`)

    // @impl BR-005
    if (from.entityType !== rt.from) {
      throw ontologyError(
        // @impl BR-006
        'ENDPOINT_TYPE_MISMATCH',
        `Relationship "${relationship}" expects from-type "${rt.from}" but got "${from.entityType}"`,
      )
    }
    if (to.entityType !== rt.to) {
      throw ontologyError(
        'ENDPOINT_TYPE_MISMATCH',
        `Relationship "${relationship}" expects to-type "${rt.to}" but got "${to.entityType}"`,
      )
    // @impl BR-006, S005-AC-011, S005-AC-015
    }

    // Idempotency: an identical edge resolves to itself, no cardinality check.
    // @impl BR-006
    const exact = await a.queryEdges({ relationship, fromId, toId })
    if (exact.length > 0) return exact[0]!

    // Cardinality (BR-006):
    // - '1..1' and '1..N': each fromId may have at most 1 outgoing edge (from-side constraint).
    // - '1..1' and 'N..1': each toId may have at most 1 incoming edge (to-side constraint).
    // @impl S005-AC-011, S005-AC-015
    if (rt.cardinality === '1..1' || rt.cardinality === '1..N') {
      const fromOut = await a.queryEdges({ relationship, fromId })
      if (fromOut.length >= 1) {
        throw ontologyError(
          // @impl S005-AC-011, S005-AC-015
          'CARDINALITY_VIOLATION',
          `"${relationship}" is ${rt.cardinality}: instance "${fromId}" already has an outgoing edge on this relationship`,
        )
      }
    }
    if (rt.cardinality === '1..1' || rt.cardinality === 'N..1') {
      const toIn = await a.queryEdges({ relationship, toId })
      if (toIn.length >= 1) {
        throw ontologyError(
          'CARDINALITY_VIOLATION',
          `"${relationship}" is ${rt.cardinality}: instance "${toId}" already has an incoming edge on this relationship`,
        )
      }
    }

    return a.insertEdge(relationship, fromId, toId, prov)
  }

  // @impl S005-AC-001, BR-001
  async unlink(
    relationship: string,
    fromId: string,
    toId: string,
    prov: Provenance,
    ctx: Ctx,
    adapter?: StorageAdapter,
  ): Promise<void> {
    this.assertWriteAllowed('unlink')
    this.requireProvenance(prov, 'unlink')
    this.functionCaches.delete(this.tenant(ctx))
    // Takes the transaction-scoped adapter when an action effect calls it, so the
    // removal commits with the rest of the effect. Without this the edge would
    // disappear even when the effect later throws and everything else rolls back.
    const a = adapter ?? this.adapter.withTenant(this.tenant(ctx))
    // FR-E05: verify the edge exists before attempting deletion.
    const existing = await a.queryEdges({ relationship, fromId, toId })
    if (existing.length === 0) {
      throw ontologyError(
        'INSTANCE_NOT_FOUND',
        `Edge (${relationship}, ${fromId}, ${toId}) not found`,
      )
    }
    // FR-E05 / NFR-S01: wrap adapter-level "not found" errors that may arise
    // from concurrent unlink() calls where the edge was already deleted between
    // the queryEdges check and the deleteEdge call.
    try {
      await a.deleteEdge(relationship, fromId, toId)
    } catch (err) {
      // Re-throw as INSTANCE_NOT_FOUND regardless of the raw adapter message
      throw ontologyError(
        'INSTANCE_NOT_FOUND',
        `Edge (${relationship}, ${fromId}, ${toId}) not found`,
      )
    }
  }

  // @impl S005-AC-001, S006-AC-001
  async neighbors(id: string, relationship: string | undefined, ctx: Ctx): Promise<Instance[]> {
    const tid = this.tenant(ctx)
    const a = this.adapter.withTenant(tid)
    const ids = new Set<string>()

    // FR-N08: traverse direction depends on the RelationshipType's directed flag.
    // When directed:true, follow only fromId===id edges (forward only).
    // When directed:false (or unknown), follow edges at either endpoint.
    // When relationship is not specified, we must inspect all edges and each type's directed flag.

    if (relationship) {
      // Named relationship — look up its directed flag.
      const rt = this.reg(tid).getRelationshipType(relationship)
      const directed = rt ? rt.directed : true // default to directed if type not found
      const outEdges = await a.queryEdges({ relationship, fromId: id })
      for (const e of outEdges) ids.add(e.toId)
      if (!directed) {
        const inEdges = await a.queryEdges({ relationship, toId: id })
        for (const e of inEdges) ids.add(e.fromId)
      }
    } else {
      // All relationships — collect all edges touching id, then per-relationship directed check.
      const outEdges = await a.queryEdges({ fromId: id })
      for (const e of outEdges) ids.add(e.toId)
      // For undirected relationships, also traverse incoming edges.
      const inEdges = await a.queryEdges({ toId: id })
      for (const e of inEdges) {
        const rt = this.reg(tid).getRelationshipType(e.relationship)
        if (rt && !rt.directed) ids.add(e.fromId)
      }
    }

    return this.readInstances(a, [...ids])
  }

  /**
   * neighbors() for a WHOLE PAGE of rows — one edge read and one instance read
   * covering every start id, instead of two reads per row.
   *
   * Why it exists: the per-id form is correct, but callers walk it in a loop to
   * decorate a list, and under an adapter that opens a transaction per read
   * that loop costs N+1 *transactions*. A downstream app measured 16 seconds on
   * a plain list this way and abandoned the graph API for hand-written SQL
   * views. "For each of these rows, its neighbours" is what a list screen
   * actually asks — so it is the shape the API should offer.
   *
   * Returns a Map keyed by start id; a start with no neighbours maps to an
   * empty array, so callers never distinguish "absent" from "none".
   */
  async neighborsOf(
    ids: readonly string[],
    relationship: string | undefined,
    ctx: Ctx,
  ): Promise<Map<string, Instance[]>> {
    const out = new Map<string, Instance[]>()
    const starts = [...new Set(ids)]
    for (const id of starts) out.set(id, [])
    if (starts.length === 0) return out

    const tid = this.tenant(ctx)
    const a = this.adapter.withTenant(tid)
    const startSet = new Set(starts)

    // Same direction rule as neighbors(): follow out-edges always, in-edges only
    // for relationships declared undirected (FR-N08).
    const directedOf = (rel: string): boolean => {
      const rt = this.reg(tid).getRelationshipType(rel)
      return rt ? rt.directed : true
    }

    const edges = await this.readEdges(a, {
      ...(relationship === undefined ? {} : { relationship }),
      fromIds: starts,
      toIds: starts,
    })

    const wanted = new Map<string, Set<string>>()
    for (const id of starts) wanted.set(id, new Set<string>())
    for (const e of edges) {
      if (startSet.has(e.fromId)) wanted.get(e.fromId)?.add(e.toId)
      if (startSet.has(e.toId) && !directedOf(e.relationship)) {
        wanted.get(e.toId)?.add(e.fromId)
      }
    }

    const every = [...new Set([...wanted.values()].flatMap((s) => [...s]))]
    const byId = new Map((await this.readInstances(a, every)).map((i) => [i.id, i]))

    for (const [start, nids] of wanted) {
      out.set(start, [...nids].flatMap((nid) => {
        const inst = byId.get(nid)
        return inst === undefined ? [] : [inst]
      }))
    }
    return out
  }

  /** Batch instance read through the adapter's native door, or a loop if it has none. */
  private async readInstances(a: StorageAdapter, ids: readonly string[]): Promise<Instance[]> {
    if (ids.length === 0) return []
    if (a.getInstances) return a.getInstances(ids)
    const out: Instance[] = []
    for (const id of ids) {
      const inst = await a.getInstance(id)
      if (inst) out.push(inst)
    }
    return out
  }

  /**
   * Batch edge read through the adapter's native door, or a loop if it has none.
   * The fallback de-duplicates by edge id: an edge with BOTH endpoints in the
   * start set comes back once from the native door but twice from the loop.
   */
  private async readEdges(a: StorageAdapter, spec: MultiEdgeQuery): Promise<Edge[]> {
    if (a.queryEdgesMulti) return a.queryEdgesMulti(spec)
    const rel = spec.relationship === undefined ? {} : { relationship: spec.relationship }
    const seen = new Map<string, Edge>()
    for (const fromId of spec.fromIds ?? []) {
      for (const e of await a.queryEdges({ ...rel, fromId })) seen.set(e.id, e)
    }
    for (const toId of spec.toIds ?? []) {
      for (const e of await a.queryEdges({ ...rel, toId })) seen.set(e.id, e)
    }
    return [...seen.values()]
  }

  // ── Traversal ───────────────────────────────────────────────────────────────

  // @impl S006-AC-001, S006-AC-002
  async traverse(spec: TraverseSpec, ctx: Ctx): Promise<TraversalResult> {
    const tid = this.tenant(ctx)
    // FR-E05: start and path are required fields
    if (typeof spec?.start !== 'string' || spec.start.trim().length === 0) {
      throw ontologyError('REQUIRED_PROPERTY_MISSING', 'traverse() requires a non-empty start id')
    }
    if (!Array.isArray(spec?.path)) {
      throw ontologyError('REQUIRED_PROPERTY_MISSING', 'traverse() requires a path array')
    // @impl S007-AC-006
    }
    // FR-E01: every element in path must be a registered RelationshipType name
    const reg = this.reg(tid)
    for (const rel of spec.path) {
      reg.requireRelationshipType(rel)
    // @impl S007-AC-009
    }
    // FR-E03: validate where condition before traversal begins
    if (spec.where !== undefined) {
      validateCondition(spec.where)
    }
    return planTraversal(spec, this.adapter.withTenant(tid))
  // @impl S007-AC-006
  }

  /**
   * Unified object-query (the agent command-set read): filter by type + where,
   * optionally hop along relationships, optionally limit. The neutral read used
   * by the Ontology Port. (Aggregation lives in Functions / AGGREGATE rules, so
   * QuerySpec.aggregate is not applied here — query returns instances.)
   */
  async query(spec: QuerySpec, ctx: Ctx): Promise<Instance[]> {
    let results = await this.find(spec.type, spec.where, ctx)
    for (const hop of spec.traverse ?? []) {
      const next: Instance[] = []
      const seen = new Set<string>()
      for (const inst of results) {
        for (const n of await this.neighbors(inst.id, hop.relationship, ctx)) {
          if (!seen.has(n.id)) {
            seen.add(n.id)
            next.push(n)
          }
        }
      }
      results = next
    }
    if (typeof spec.limit === 'number') results = results.slice(0, spec.limit)
    return results
  }

  // ── Rules ─────────────────────────────────────────────────────────────────

  // @impl BR-008, S007-AC-001, S007-AC-006, S007-AC-009
  async registerRule(def: RuleDef, ctx: Ctx): Promise<void> {
    const tid = this.tenant(ctx)
    // FR-E02: build the set of known EntityType + RelationshipType names for appliesTo validation
    // @impl S007-AC-010
    const schema = this.reg(tid).getSchema()
    const knownTypes = new Set<string>([
      ...schema.entityTypes.map((e) => e.name),
      ...schema.relationshipTypes.map((r) => r.name),
    ])
    // @impl S008-AC-006, S008-AC-010
    await registerRule(def, this.adapter.withTenant(tid), knownTypes)
  }

  // @impl S007-AC-002, BR-009
  async listRules(
    filter: { appliesTo?: string; enabled?: boolean; kind?: RuleKind } | undefined,
    ctx: Ctx,
  // @impl S007-AC-010
  ): Promise<RuleDef[]> {
    return listRules(this.adapter.withTenant(this.tenant(ctx)), filter)
  }

  // @impl BR-009, S007-AC-002, S007-AC-010, S008-AC-006, S008-AC-010
  async disableRule(id: string, prov: Provenance, ctx: Ctx): Promise<void> {
    await disableRule(id, prov, this.adapter.withTenant(this.tenant(ctx)))
  }

  // @impl S008-AC-001, S008-AC-002, S008-AC-006, S008-AC-010
  async evaluateFlags(scope: EvalScope): Promise<Flag[]> {
    if (typeof scope?.tenantId !== 'string' || scope.tenantId.trim().length === 0) {
      throw ontologyError('TENANT_MISMATCH', 'EvalScope.tenantId is required')
    }
    const tid = scope.tenantId
    // SEC-OTHER-08: require at least one narrowing constraint so the engine never
    // fetches all instances of all entity types for every rule in one call.
    const hasScope =
      (scope.entityType !== undefined && scope.entityType.trim().length > 0) ||
      (scope.ids !== undefined && scope.ids.length > 0)
    if (!hasScope) {
      throw ontologyError(
        'REQUIRED_PROPERTY_MISSING',
        'EvalScope must specify at least one of entityType or ids to prevent unbounded evaluation',
      )
    }
    // FR-E02: reject unknown entityType before touching the adapter
    if (scope.entityType !== undefined) {
      const schema = this.reg(tid).getSchema()
      const known = new Set(schema.entityTypes.map((e) => e.name))
      if (!known.has(scope.entityType)) {
        throw ontologyError('UNKNOWN_ENTITY_TYPE', `Unknown entityType "${scope.entityType}" in EvalScope`)
      }
    }
    return evaluateRules(scope, this.adapter.withTenant(tid))
  }

  /**
   * Evaluate rules over a scope and return NEUTRAL results (the kinetic API):
   * no flag rendering, no severity interpretation, no persistence, no auto-run
   * — detection only. Each fired (rule, instance) becomes a RuleResult that
   * carries the rule's `onFail` intent as data; the host's reaction layer (or a
   * workflow step) decides what to do. `evaluateFlags` remains for the
   * flag-shaped projection.
   */
  async evaluateRules(scope: EvalScope): Promise<RuleResult[]> {
    const flags = await this.evaluateFlags(scope)
    // Load rule defs once to carry `onFail` intent onto the results.
    const defs = await this.adapter.withTenant(scope.tenantId).queryRules({})
    const onFailById = new Map(defs.map((r) => [r.id, r.onFail]))
    return flags.map((f) => {
      const result: RuleResult = {
        ruleId: f.ruleId,
        target: f.instanceId,
        fired: true,
        severityLabel: f.severity,
        message: f.message,
        trace: f.trace,
      }
      const onFail = onFailById.get(f.ruleId)
      if (onFail) result.onFail = onFail
      return result
    })
  }

  // ── Context retrieval (NT5) ─────────────────────────────────────────────────

  // @impl S009-AC-001, S009-AC-002
  async context(opts: ContextOpts, ctx: Ctx): Promise<ContextBundle> {
    const tid = this.tenant(ctx)
    // FR-E03: query is required and must be non-empty
    if (typeof opts?.query !== 'string' || opts.query.trim().length === 0) {
      throw ontologyError('REQUIRED_PROPERTY_MISSING', 'context() requires a non-empty query string')
    }
    return retrieveContext(
      opts,
      this.adapter.withTenant(tid),
      this.vector?.withTenant(tid),
      this.embed,
    )
  }
}
