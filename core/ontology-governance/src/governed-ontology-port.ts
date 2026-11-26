// GovernedOntologyPort — the governance binding over the ontology kernel.
// A Decorator that wraps any OntologyPort (e.g. the SDK's `Ontology`) and runs
// an interceptor chain (RBAC → audit → provenance) around the SINGLE write door,
// `applyAction`, uniformly for every caller (human · workflow · trigger · agent).
// Reads pass through (an optional read-scope interceptor can be added later).

import type {
  OntologyPort,
  EntityTypeDef,
  RelationshipTypeDef,
  ActionTypeDef,
  FunctionTypeDef,
  Instance,
  ConditionExpr,
  TraverseSpec,
  TraversalResult,
  QuerySpec,
  Args,
  Value,
  Provenance,
  OntologyEvent,
  RuleDef,
  EvalScope,
  RuleResult,
  OntologySchema,
  Ctx,
  IngestBulkPayload,
  IngestBulkResult,
} from '@dqa-ai-solutions/ontology-sdk'

export class GovernanceError extends Error {
  readonly code: string
  constructor(message: string, code = 'GOVERNANCE_DENIED') {
    super(message)
    this.name = 'GovernanceError'
    this.code = code
  }
}

/**
 * Interceptor around `applyAction`. `before` may throw to reject (RBAC / policy);
 * `after` observes the emitted events (audit / provenance / event forwarding).
 * Interceptors never mutate params or events.
 */
export interface ActionInterceptor {
  before?(name: string, params: Args, prov: Provenance, ctx: Ctx): void | Promise<void>
  // `after` also receives the original params + provenance so an audit sink can
  // record the full governed write (what, by whom, with what provenance) without
  // stashing per-call state. Older interceptors ignore the trailing args.
  after?(name: string, events: OntologyEvent[], ctx: Ctx, params?: Args, prov?: Provenance): void | Promise<void>
}

export class GovernedOntologyPort implements OntologyPort {
  constructor(
    private readonly inner: OntologyPort,
    private readonly chain: ActionInterceptor[] = [],
  ) {}

  // ── The governed write door ─────────────────────────────────────────────────
  async applyAction(name: string, params: Args, prov: Provenance, ctx: Ctx): Promise<OntologyEvent[]> {
    for (const i of this.chain) await i.before?.(name, params, prov, ctx)
    const events = await this.inner.applyAction(name, params, prov, ctx)
    for (const i of this.chain) await i.after?.(name, events, ctx, params, prov)
    return events
  }

  // ── Bulk write door for ingest (coarse audit) ───────────────────────────────
  // Runs the same interceptor chain ONCE for the whole batch: `before` still
  // gates (RBAC/policy) on a synthetic `ingest` action, and `after` records a
  // SINGLE audit entry summarising the batch — not one per item. Per-item audit
  // is redundant for ingest (bulk-machine, pre-validated, deterministic from
  // source docs); human writes keep full per-action audit via applyAction.
  async ingestBulk(payload: IngestBulkPayload, prov: Provenance, ctx: Ctx): Promise<IngestBulkResult> {
    const params = { instances: payload.instances?.length ?? 0, links: payload.links?.length ?? 0 } as unknown as Args
    for (const i of this.chain) await i.before?.('ingest', params, prov, ctx)
    const result = await this.inner.ingestBulk(payload, prov, ctx)
    // One synthetic event so the audit sink logs a single "ingest" act carrying
    // the batch counts (in params) — the coarse audit record for the batch.
    const summary: OntologyEvent = {
      id: '',
      ts: new Date().toISOString(),
      type: 'ingest.batch',
      aggregate: 'ingest',
      payload: result as unknown as Value,
      actor: ctx.actor ?? 'system',
      version: 0,
    }
    for (const i of this.chain) await i.after?.('ingest', [summary], ctx, params, prov)
    return result
  }

  // ── Pass-through: schema / reads / functions / rules ──────────────────────────
  getSchema(ctx: Ctx): Promise<OntologySchema> { return this.inner.getSchema(ctx) }
  defineEntityType(def: EntityTypeDef, ctx: Ctx): Promise<void> { return this.inner.defineEntityType(def, ctx) }
  defineRelationshipType(def: RelationshipTypeDef, ctx: Ctx): Promise<void> { return this.inner.defineRelationshipType(def, ctx) }
  defineAction(def: ActionTypeDef, ctx: Ctx): Promise<void> { return this.inner.defineAction(def, ctx) }
  defineFunction(def: FunctionTypeDef, ctx: Ctx): Promise<void> { return this.inner.defineFunction(def, ctx) }
  get(id: string, ctx: Ctx): Promise<Instance | null> { return this.inner.get(id, ctx) }
  find(type: string, where: ConditionExpr | undefined, ctx: Ctx): Promise<Instance[]> { return this.inner.find(type, where, ctx) }
  neighbors(id: string, relationship: string | undefined, ctx: Ctx): Promise<Instance[]> { return this.inner.neighbors(id, relationship, ctx) }
  // Reads pass straight through — governance is about the WRITE door. Passing
  // the batch form through as well matters: if it were missing, a caller behind
  // governance would silently fall back to the per-id loop and pay N+1 for the
  // read the batch form exists to remove.
  neighborsOf(
    ids: readonly string[],
    relationship: string | undefined,
    ctx: Ctx,
  ): Promise<Map<string, Instance[]>> { return this.inner.neighborsOf(ids, relationship, ctx) }
  traverse(spec: TraverseSpec, ctx: Ctx): Promise<TraversalResult> { return this.inner.traverse(spec, ctx) }
  query(spec: QuerySpec, ctx: Ctx): Promise<Instance[]> { return this.inner.query(spec, ctx) }
  callFunction(name: string, args: Args, ctx: Ctx): Promise<Value> { return this.inner.callFunction(name, args, ctx) }
  registerRule(def: RuleDef, ctx: Ctx): Promise<void> { return this.inner.registerRule(def, ctx) }
  evaluateRules(scope: EvalScope): Promise<RuleResult[]> { return this.inner.evaluateRules(scope) }
}

// ── Built-in interceptors ───────────────────────────────────────────────────

export interface AuditRecord {
  action: string
  actor: string
  events: number
  at: string
  /** Action params + provenance, when the port supplies them (for the ledger). */
  params?: Args
  provenance?: Provenance
}

/** Records one audit entry per applied action into the given sink. The sink may
 *  be async (e.g. an append-only ledger write); applyAction awaits it. */
export function auditInterceptor(sink: (rec: AuditRecord) => void | Promise<void>): ActionInterceptor {
  return {
    async after(name, events, ctx, params, prov) {
      await sink({
        action: name,
        actor: ctx.actor ?? 'system',
        events: events.length,
        at: events[0]?.ts ?? '',
        ...(params !== undefined ? { params } : {}),
        ...(prov !== undefined ? { provenance: prov } : {}),
      })
    },
  }
}

/**
 * Capability gate (Step 2 — hard write door): reject any Action whose name is
 * not in the capabilities granted to the current step. The grant comes from the
 * skill's `tools:` frontmatter, surfaced per agent checkpoint. Add this BEFORE
 * rbac so an out-of-scope write is refused regardless of role.
 */
export function capabilityInterceptor(allowed: string[]): ActionInterceptor {
  const set = new Set(allowed)
  return {
    before(name) {
      if (!set.has(name)) {
        throw new GovernanceError(
          `action "${name}" is not in the granted capabilities [${allowed.join(', ')}]`,
          'CAPABILITY_DENIED',
        )
      }
    },
  }
}

/**
 * RBAC: reject an action when the policy denies it for the calling actor/ctx.
 * `can(action, ctx) => boolean`. Full role/tenancy policy is M4; this is the hook.
 */
export function rbacInterceptor(can: (action: string, ctx: Ctx) => boolean): ActionInterceptor {
  return {
    before(name, _params, _prov, ctx) {
      if (!can(name, ctx)) {
        throw new GovernanceError(`actor "${ctx.actor ?? 'anonymous'}" is not permitted to apply action "${name}"`)
      }
    },
  }
}
