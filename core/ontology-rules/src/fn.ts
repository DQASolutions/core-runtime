// Ergonomic authoring for an app's logic — the v1 surface for writing
// Functions, Rules and Actions as plain TypeScript. Each helper returns a
// TAGGED SPEC (no global/mutable registry — multi-tenant safe). `loadFunctions`
// collects the specs a module EXPORTS and binds them into the ontology via the
// existing `defineFunctionImpl` / `defineActionImpl` SPI; rules are grouped by
// the entity type they apply to so the `check` step can sweep them.
//
// v1 (Option A): bodies use the REAL runtime shape — read properties off
// `instance.data`, follow links via `io.neighbors(id, relationship)`. Friendlier
// typed accessors (e.g. `g.category` / `g.log`) are a later, additive layer
// (codegen). Within an app, a rule just calls its own helper functions directly
// (normal TS); `compute`/`action` registration is for EXTERNAL callers (the
// command-set CLI / a skill) reaching them by name.

import type { Args, Ctx, Instance, Value, FunctionIO, ActionIO, EventSeed, GuardResult } from '@dqa-ai-solutions/ontology-sdk'

/** A named, pure computation — bound as a Function (callable by name). */
export interface ComputeSpec {
  kind: 'compute'
  name: string
  body: (args: Args, ctx: Ctx, io: FunctionIO) => Value | Promise<Value>
}

/**
 * Rich detail a rule attaches WHEN it fires — what `check`/`report` render and
 * sort on, so a rule (not a separate report engine) is the single source of
 * truth for "what's wrong, by how much". All fields optional except `message`.
 */
export interface Finding {
  /** Human-readable "cái gì sai/thiếu" — the detail line of a report row. */
  message: string
  /** Short subject of the row (đối tượng/nút) — the bold title of a report row. */
  label?: string
  /** Numeric magnitude (số tiền lệch) — for sorting + summing across findings. */
  delta?: number
  /** Bucket the app groups by, e.g. `'sai' | 'thieu'`. Defaults to `RuleSpec.category`. */
  category?: string
  /** Mức độ CỦA CA NÀY, đè `RuleSpec.severity`. Cùng một luật có thể vừa là bằng chứng ĐÃ RÀ
   *  ("lãi vay trong hạn" — info) vừa là vi phạm ("vượt trần" — warning); mức tĩnh buộc phải chọn
   *  một, và chọn nào cũng sai một nửa: gọi ca đạt là cảnh báo thì người đọc mất tin, gọi ca vượt
   *  là thông tin thì bỏ lọt tiền thuế. */
  severity?: string
}

/**
 * What a per-instance predicate may return: a boolean (fired/not, default
 * detail) OR a {@link Finding} (fired WITH rich detail). Falsy ⇒ did not fire.
 * Backward compatible — `boolean` is still a valid verdict.
 */
export type RuleVerdict = boolean | Finding | null | undefined

/** A check on one entity type. Either form returns the violating instances. */
export interface RuleSpec {
  kind: 'rule'
  /** Entity type this rule applies to (the sweep scope). */
  on: string
  id: string
  severity?: string
  /** Default finding bucket for this rule (a per-finding `category` overrides it). */
  category?: string
  /** Per-instance predicate — the kernel sweeps every instance of `on`. Return a
   *  {@link Finding} to carry detail, or a boolean for fired/not. */
  khi?: (g: Instance, io: FunctionIO) => RuleVerdict | Promise<RuleVerdict>
  /** Collection finder — returns the violating instances itself (aggregate). */
  timViPham?: (io: FunctionIO) => Instance[] | Promise<Instance[]>
  /** Optional finding builder for a violating instance — enriches a boolean `khi`
   *  or a `timViPham` violator into a {@link Finding}. */
  moTa?: (g: Instance, io: FunctionIO) => Finding | Promise<Finding>
}

/** A governed write — bound as an Action (the sole mutation door). */
export interface ActionSpec {
  kind: 'action'
  name: string
  guard?: (args: Args, ctx: Ctx) => GuardResult | Promise<GuardResult>
  effect: (args: Args, ctx: Ctx, io: ActionIO) => EventSeed[] | Promise<EventSeed[]>
}

export type FnSpec = ComputeSpec | RuleSpec | ActionSpec

/** Declare a named pure computation. */
export function compute(name: string, body: ComputeSpec['body']): ComputeSpec {
  return { kind: 'compute', name, body }
}

/** Declare a check on an entity type. Requires `khi` (per-instance) or `timViPham` (collection). */
export function rule(spec: Omit<RuleSpec, 'kind'>): RuleSpec {
  if (!spec.khi && !spec.timViPham) {
    throw new Error(`rule "${spec.id}" (on ${spec.on}): cần một trong "khi" hoặc "timViPham"`)
  }
  return { kind: 'rule', ...spec }
}

/** Declare a governed write action. */
export function action(name: string, spec: Omit<ActionSpec, 'kind' | 'name'>): ActionSpec {
  return { kind: 'action', name, ...spec }
}

export function isFnSpec(v: unknown): v is FnSpec {
  if (!v || typeof v !== 'object' || !('kind' in v)) return false
  const k = (v as { kind: unknown }).kind
  return k === 'compute' || k === 'rule' || k === 'action'
}

/** The specs collected from an app's `functions/` modules. */
export interface CollectedSpecs {
  computes: ComputeSpec[]
  actions: ActionSpec[]
  /** Rules grouped by the entity type they apply to (the `check` sweep map). */
  rulesByType: Record<string, RuleSpec[]>
}

/**
 * Collect the FnSpecs a module exports (directly, or inside an exported array),
 * merging into `into` when accumulating across many modules. No global state:
 * each call returns/extends an explicit accumulator.
 */
export function collectSpecs(moduleExports: Record<string, unknown>, into?: CollectedSpecs): CollectedSpecs {
  const acc: CollectedSpecs = into ?? { computes: [], actions: [], rulesByType: {} }
  for (const v of Object.values(moduleExports)) {
    if (Array.isArray(v)) {
      for (const x of v) if (isFnSpec(x)) addSpec(acc, x)
    } else if (isFnSpec(v)) {
      addSpec(acc, v)
    }
  }
  return acc
}

function addSpec(acc: CollectedSpecs, s: FnSpec): void {
  if (s.kind === 'compute') acc.computes.push(s)
  else if (s.kind === 'action') acc.actions.push(s)
  else (acc.rulesByType[s.on] ??= []).push(s)
}
