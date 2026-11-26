// Action runtime — the kinetic write layer. An Action is the ONLY governed way
// to mutate the graph: a named verb with optional params + a guard (submission-
// criteria) + an effect body. `createInstance` / `link` / `updateInstance` are
// built-in Actions. Apps bind their own Actions via the SPI (def + guard +
// effect). The runtime runs the guard, executes the effect through a governed
// IO surface, and stamps the emitted events.
//
// Pure kernel mechanism — no domain terms (qg4), no infra deps (qg2).

import type { Args, Ctx } from '../../types/index.js'
import { ontologyError } from '../../types/index.js'
import type { ActionTypeDef, OntologyEvent, Value } from '../../types/kinetic.js'

/** The governed primitive writes an effect may perform (built on the adapter). */
export interface ActionIO {
  create(entityType: string, data: Record<string, unknown>): Promise<{ id: string }>
  /** Create-or-replace by a stable business key (`ref`); id is derived
   *  deterministically so the same ref always resolves to the same instance. */
  upsert(entityType: string, ref: string, data: Record<string, unknown>): Promise<{ id: string }>
  update(id: string, patch: Record<string, unknown>): Promise<{ id: string }>
  link(relationship: string, fromId: string, toId: string): Promise<void>
  /**
   * Remove an edge. The inverse of `link`, and the door was missing it.
   *
   * Committing a unit to an incident and later standing it down is ordinary
   * business, not an exception: an app could add a relationship through the
   * governed door but never remove one, so the only ways out were to close the
   * whole parent record or to write raw SQL — the second bypasses provenance and
   * the event log, which is the one thing this door exists to prevent.
   *
   * Throws INSTANCE_NOT_FOUND when the edge is not there, so "remove what is not
   * attached" is a mistake the effect hears about rather than a silent no-op.
   */
  unlink(relationship: string, fromId: string, toId: string): Promise<void>
}

/** What an effect declares it changed; the runtime stamps id/ts/actor/version. */
export interface EventSeed {
  type: string
  aggregate: string
  payload?: Value
}

export type GuardResult = boolean | { ok: boolean; reason?: string }

/** A registered action: signature (def) + optional guard + effect body (SPI). */
export interface ActionImpl {
  def: ActionTypeDef
  guard?: (args: Args, ctx: Ctx) => GuardResult | Promise<GuardResult>
  effect: (args: Args, ctx: Ctx, io: ActionIO) => EventSeed[] | Promise<EventSeed[]>
}

export class ActionRegistry {
  private readonly impls = new Map<string, ActionImpl>()

  /** Bind a full action (signature + guard + effect). Overwrites by name. */
  define(impl: ActionImpl): void {
    this.impls.set(impl.def.name, impl)
  }

  /**
   * Register a signature with no body yet (the Port's `defineAction`). If a
   * full impl was already bound, only the signature is refreshed. A
   * signature-only action throws if applied before its effect is bound.
   */
  declare(def: ActionTypeDef): void {
    const existing = this.impls.get(def.name)
    if (existing) {
      existing.def = def
      return
    }
    this.impls.set(def.name, {
      def,
      effect: () => {
        throw ontologyError(
          'ACTION_NOT_BOUND',
          `Action "${def.name}" is declared but has no effect bound (bind it via defineActionImpl)`,
        )
      },
    })
  }

  get(name: string): ActionImpl | undefined {
    return this.impls.get(name)
  }
  has(name: string): boolean {
    return this.impls.has(name)
  }
  list(): ActionTypeDef[] {
    return [...this.impls.values()].map((i) => i.def)
  }
}

// Monotonic suffix so events emitted within the same millisecond stay ordered.
let _seq = 0

/** Stamp effect-declared seeds into full events (id · ts · actor · version). */
export function stampEvents(seeds: EventSeed[], ctx: Ctx): OntologyEvent[] {
  const ts = new Date().toISOString()
  const actor = ctx.actor ?? 'system'
  return seeds.map((s) => ({
    id: `evt_${ts}_${++_seq}`,
    ts,
    type: s.type,
    aggregate: s.aggregate,
    payload: s.payload ?? null,
    actor,
    // Per-aggregate event versioning belongs to the event store (M2). Until
    // then every emitted event is stamped v1.
    version: 1,
  }))
}

/** Run one action: guard (submission-criteria) → effect → stamped events. */
export async function runAction(
  impl: ActionImpl,
  args: Args,
  ctx: Ctx,
  io: ActionIO,
): Promise<OntologyEvent[]> {
  if (impl.guard) {
    const g = await impl.guard(args, ctx)
    const ok = typeof g === 'boolean' ? g : g.ok
    if (!ok) {
      const reason = typeof g === 'boolean' || !g.reason ? '' : `: ${g.reason}`
      throw ontologyError(
        'ACTION_GUARD_FAILED',
        `Action "${impl.def.name}" rejected by submission criteria${reason}`,
      )
    }
  }
  const seeds = await impl.effect(args, ctx, io)
  return stampEvents(seeds, ctx)
}

/** Built-in Actions every tenant gets — the kernel's governed primitive writes. */
export function builtinActions(): ActionImpl[] {
  return [
    {
      def: { name: 'createInstance', params: { type: { type: 'string' }, props: { type: 'object', optional: true } } },
      effect: async (args, _ctx, io) => {
        const { id } = await io.create(String(args.type), (args.props as Record<string, unknown>) ?? {})
        return [{ type: 'instance.created', aggregate: id, payload: args.props ?? null }]
      },
    },
    {
      // Idempotent create-or-replace keyed on a stable `ref`. Re-applying the
      // same (type, ref, props) overwrites the same node — the seam that lets an
      // interrupted/repeated ingest converge instead of duplicating the graph.
      def: { name: 'upsertInstance', params: { type: { type: 'string' }, ref: { type: 'string' }, props: { type: 'object', optional: true } } },
      effect: async (args, _ctx, io) => {
        const { id } = await io.upsert(String(args.type), String(args.ref), (args.props as Record<string, unknown>) ?? {})
        return [{ type: 'instance.upserted', aggregate: id, payload: args.props ?? null }]
      },
    },
    {
      def: { name: 'updateInstance', params: { id: { type: 'string' }, patch: { type: 'object' } } },
      effect: async (args, _ctx, io) => {
        const { id } = await io.update(String(args.id), (args.patch as Record<string, unknown>) ?? {})
        return [{ type: 'instance.updated', aggregate: id, payload: args.patch ?? null }]
      },
    },
    {
      def: { name: 'link', params: { relationship: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } } },
      effect: async (args, _ctx, io) => {
        const relationship = String(args.relationship)
        const from = String(args.from)
        const to = String(args.to)
        await io.link(relationship, from, to)
        return [{ type: 'edge.created', aggregate: from, payload: { relationship, to } }]
      },
    },
    {
      // The inverse of `link`. Attaching a thing and later detaching it is the
      // normal life of a record, so both directions belong to the same governed
      // door — otherwise the only way back out is raw storage access, with no
      // provenance and no event.
      def: { name: 'unlink', params: { relationship: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } } },
      effect: async (args, _ctx, io) => {
        const relationship = String(args.relationship)
        const from = String(args.from)
        const to = String(args.to)
        await io.unlink(relationship, from, to)
        return [{ type: 'edge.removed', aggregate: from, payload: { relationship, to } }]
      },
    },
  ]
}
