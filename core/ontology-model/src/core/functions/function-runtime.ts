// Function runtime — named, deterministic, pure computations over the graph
// (a "named formula": SoDu, Aggregate, ReconDelta…). Read-only: a Function may
// query the graph but never mutate it (mutation is the Action runtime's job).
// Results are memoizable because Functions are pure given the graph state — the
// Ontology facade caches them and clears the cache on any write.
//
// Pure kernel mechanism — no domain terms (qg4), no infra deps (qg2).

import type { Args, Ctx, Instance, ConditionExpr, TraverseSpec, TraversalResult } from '../../types/index.js'
import { ontologyError } from '../../types/index.js'
import type { FunctionTypeDef, Value } from '../../types/kinetic.js'

/** Read-only graph surface a Function body may use (no writes — purity). */
export interface FunctionIO {
  get(id: string): Promise<Instance | null>
  find(type: string, where?: ConditionExpr): Promise<Instance[]>
  neighbors(id: string, relationship?: string): Promise<Instance[]>
  traverse(spec: TraverseSpec): Promise<TraversalResult>
}

/** A registered function: signature (def) + pure body (SPI). */
export interface FunctionImpl {
  def: FunctionTypeDef
  body: (args: Args, ctx: Ctx, io: FunctionIO) => Value | Promise<Value>
}

export class FunctionRegistry {
  private readonly impls = new Map<string, FunctionImpl>()

  define(impl: FunctionImpl): void {
    this.impls.set(impl.def.name, impl)
  }

  /** Register a signature with no body yet (the Port's `defineFunction`). */
  declare(def: FunctionTypeDef): void {
    const existing = this.impls.get(def.name)
    if (existing) {
      existing.def = def
      return
    }
    this.impls.set(def.name, {
      def,
      body: () => {
        throw ontologyError(
          'FUNCTION_NOT_BOUND',
          `Function "${def.name}" is declared but has no body bound (bind it via defineFunctionImpl)`,
        )
      },
    })
  }

  get(name: string): FunctionImpl | undefined {
    return this.impls.get(name)
  }
  has(name: string): boolean {
    return this.impls.has(name)
  }
  list(): FunctionTypeDef[] {
    return [...this.impls.values()].map((i) => i.def)
  }
}

/** Stable cache key for a (name, args) call. */
export function functionCacheKey(name: string, args: Args): string {
  return `${name}::${stableStringify(args)}`
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const obj = v as Record<string, unknown>
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}
