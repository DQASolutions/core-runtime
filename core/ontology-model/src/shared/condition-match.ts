// Pure, backend-agnostic evaluation of the PROPERTY-LEVEL subset of a
// ConditionExpr against a plain data object. Shared by the InMemoryAdapter
// (find() filtering) and the core rule interpreter (property leaves) so both
// behave identically (QG-5 parity). Relationship ops (exists/absent/count) are
// NOT handled here — they require edge access and live in the core interpreter.

import {
  type CompareOp,
  type ConditionExpr,
  type ValueRef,
  ontologyError,
} from '../types/index.js'

function compare(left: unknown, cmp: CompareOp, right: unknown): boolean {
  switch (cmp) {
    case '=':
      return left === right
    case '!=':
      return left !== right
    case '>':
      return (left as number) > (right as number)
    case '<':
      return (left as number) < (right as number)
    case '>=':
      return (left as number) >= (right as number)
    case '<=':
      return (left as number) <= (right as number)
    default:
      throw ontologyError('UNSUPPORTED_OP', `Unknown compare operator "${String(cmp)}"`)
  }
}

/** Resolve a property/literal ValueRef against a single data object. */
export function resolveScalar(ref: ValueRef, data: Record<string, unknown>): unknown {
  switch (ref.kind) {
    case 'literal':
      return ref.value
    case 'property':
      return data[ref.name]
    default:
      throw ontologyError(
        'UNSUPPORTED_OP',
        `ValueRef kind "${ref.kind}" is not resolvable at the property level`,
      )
  }
}

/**
 * Evaluate the property-level subset of `expr` against `data`. Throws
 * UNSUPPORTED_OP if a relationship op or non-scalar ValueRef appears — those
 * are invalid in a find() where-clause (they belong to rule evaluation).
 */
export function matchesProperties(expr: ConditionExpr, data: Record<string, unknown>): boolean {
  switch (expr.op) {
    case 'and':
      return expr.clauses.every((c) => matchesProperties(c, data))
    case 'or':
      return expr.clauses.some((c) => matchesProperties(c, data))
    case 'not':
      return !matchesProperties(expr.clause, data)
    case 'compare':
      return compare(
        resolveScalar(expr.left, data),
        expr.cmp,
        resolveScalar(expr.right, data),
      )
    case 'exists':
    case 'absent':
    case 'count':
      throw ontologyError(
        'UNSUPPORTED_OP',
        `Relationship op "${expr.op}" is not valid in a find() filter — use it inside a rule`,
      )
    default:
      throw ontologyError('INVALID_CONDITION_EXPR', `Unknown op "${(expr as { op: string }).op}"`)
  }
}
