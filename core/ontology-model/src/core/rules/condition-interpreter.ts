// Rule & Evaluation context (Layer 2) — validates and evaluates a ConditionExpr
// (ADR-0003). For rules, the full tree is interpreted per-instance using the
// StorageAdapter as the only primitive (queryEdges / queryInstances / getInstance),
// so the same rule yields the same flags on every backend (QG-5).
//
// `absent` tests RECORD EXISTENCE, not value — this is the R6/R8 axis a classifier
// cannot express (BR-011, source-spec §2.4/§5).

import {
  type CompareOp,
  type ConditionExpr,
  type EdgeDirection,
  type Instance,
  type ValueRef,
  ontologyError,
} from '../../types/index.js'
import type { StorageAdapter } from '../../ports/storage-adapter.js'
import { matchesProperties } from '../../shared/condition-match.js'

const COMPARE_OPS = new Set<CompareOp>(['=', '!=', '>', '<', '>=', '<='])

/** Structural validation of a ConditionExpr tree. Throws on malformed input. */
export function validateCondition(expr: ConditionExpr): void {
  switch (expr?.op) {
    case 'and':
    case 'or':
      if (!Array.isArray(expr.clauses) || expr.clauses.length === 0) {
        throw ontologyError('INVALID_CONDITION_EXPR', `"${expr.op}" requires a non-empty clauses array`)
      }
      expr.clauses.forEach(validateCondition)
      return
    case 'not':
      validateCondition(expr.clause)
      return
    case 'compare':
      if (!COMPARE_OPS.has(expr.cmp)) {
        throw ontologyError('INVALID_CONDITION_EXPR', `Invalid compare op "${String(expr.cmp)}"`)
      }
      validateValueRef(expr.left)
      validateValueRef(expr.right)
      return
    case 'exists':
    case 'absent':
      if (typeof expr.relationship !== 'string' || expr.relationship.length === 0) {
        throw ontologyError('INVALID_CONDITION_EXPR', `"${expr.op}" requires a relationship name`)
      }
      validateDirection(expr.op, expr.direction)
      if (expr.where) validateCondition(expr.where)
      return
    case 'count':
      if (typeof expr.relationship !== 'string' || !COMPARE_OPS.has(expr.cmp) || typeof expr.n !== 'number') {
        throw ontologyError('INVALID_CONDITION_EXPR', `"count" requires relationship, cmp and numeric n`)
      }
      validateDirection(expr.op, expr.direction)
      return
    case 'aggregate':
      if (!Array.isArray(expr.groupBy) || expr.groupBy.length === 0) {
        throw ontologyError('INVALID_CONDITION_EXPR', `"aggregate" requires a non-empty groupBy array`)
      }
      if (expr.fn !== 'sum' && expr.fn !== 'count') {
        throw ontologyError('INVALID_CONDITION_EXPR', `"aggregate" fn must be "sum" or "count"`)
      }
      if (expr.fn === 'sum' && (typeof expr.field !== 'string' || expr.field.length === 0)) {
        throw ontologyError('INVALID_CONDITION_EXPR', `"aggregate" with fn "sum" requires a field`)
      }
      if (!COMPARE_OPS.has(expr.cmp) || typeof expr.threshold !== 'number') {
        throw ontologyError('INVALID_CONDITION_EXPR', `"aggregate" requires cmp and a numeric threshold`)
      }
      return
    default:
      throw ontologyError('INVALID_CONDITION_EXPR', `Unknown op "${(expr as { op?: string })?.op}"`)
  }
}

function validateValueRef(ref: ValueRef): void {
  switch (ref?.kind) {
    case 'literal':
    case 'property':
    case 'aggregate':
    case 'sourceValue':
      return
    default:
      throw ontologyError('INVALID_CONDITION_EXPR', `Unknown ValueRef kind "${(ref as { kind?: string })?.kind}"`)
  }
}

function compareValues(left: unknown, cmp: CompareOp, right: unknown): boolean {
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
  }
}

async function resolveValueRef(
  ref: ValueRef,
  instance: Instance,
  adapter: StorageAdapter,
): Promise<unknown> {
  switch (ref.kind) {
    case 'literal':
      return ref.value
    case 'property':
      return instance.data[ref.name]
    case 'aggregate': {
      // over = a relationship name; aggregate over the neighbour instances.
      const edges = await adapter.queryEdges({ relationship: ref.over, fromId: instance.id })
      if (ref.fn === 'count') return edges.length
      let sum = 0
      for (const e of edges) {
        const node = await adapter.getInstance(e.toId)
        const v = ref.property ? node?.data[ref.property] : undefined
        if (typeof v === 'number') sum += v
      }
      return sum
    }
    case 'sourceValue': {
      // External numbers enter as instances of an EntityType named `source`
      // (A-003); sum the `metric` property across them for the scope.
      const rows = await adapter.queryInstances(ref.source, null)
      let sum = 0
      for (const r of rows) {
        const v = r.data[ref.metric]
        if (typeof v === 'number') sum += v
      }
      return sum
    }
  }
}

/**
 * Evaluate a ConditionExpr for one instance. TRUE means the rule's flag
 * condition holds for this instance → a Flag should be raised.
 */
export async function evaluateRuleCondition(
  expr: ConditionExpr,
  instance: Instance,
  adapter: StorageAdapter,
): Promise<boolean> {
  switch (expr.op) {
    case 'and':
      for (const c of expr.clauses) if (!(await evaluateRuleCondition(c, instance, adapter))) return false
      return true
    case 'or':
      for (const c of expr.clauses) if (await evaluateRuleCondition(c, instance, adapter)) return true
      return false
    case 'not':
      return !(await evaluateRuleCondition(expr.clause, instance, adapter))
    case 'compare': {
      const left = await resolveValueRef(expr.left, instance, adapter)
      const right = await resolveValueRef(expr.right, instance, adapter)
      return compareValues(left, expr.cmp, right)
    }
    case 'exists':
      return (await matchingEdgeCount(
        expr.relationship, expr.where, expr.direction, instance, adapter,
      )) > 0
    // @impl BR-011
    case 'absent':
      return (await matchingEdgeCount(
        expr.relationship, expr.where, expr.direction, instance, adapter,
      )) === 0
    case 'count':
      return compareValues(
        await matchingEdgeCount(expr.relationship, undefined, expr.direction, instance, adapter),
        expr.cmp,
        expr.n,
      )
    // ⛔ `aggregate` groups instances; it has no answer for ONE instance. The rule
    //    evaluator runs it as a separate pass when it is a rule's whole condition.
    //    Nested (`not`, `and`, `or`) or in a query's `where`, it used to fall out of
    //    this switch as `undefined` — falsy, so `not(aggregate)` held for every
    //    instance and flagged them all. Refuse it instead of answering wrong.
    case 'aggregate':
      throw ontologyError(
        'INVALID_CONDITION_EXPR',
        '"aggregate" groups instances and cannot be evaluated for one instance — use it only as a rule\'s whole condition',
      )
  }
}

const DIRECTIONS = new Set<string>(['out', 'in', 'either'])

/** Reject a misspelt direction loudly. Ignoring it would silently fall back to
 *  `out` and count the wrong end — a rule that looks right and answers wrong. */
function validateDirection(op: string, direction: unknown): void {
  if (direction === undefined) return
  if (typeof direction !== 'string' || !DIRECTIONS.has(direction)) {
    throw ontologyError(
      'INVALID_CONDITION_EXPR',
      `"${op}" direction must be "out", "in" or "either" — got ${JSON.stringify(direction)}`,
    )
  }
}

async function matchingEdgeCount(
  relationship: string,
  where: ConditionExpr | undefined,
  direction: EdgeDirection | undefined,
  instance: Instance,
  adapter: StorageAdapter,
): Promise<number> {
  // 'out' is the default so every rule written before direction existed keeps
  // meaning exactly what it meant.
  const dir: EdgeDirection = direction ?? 'out'

  // The FAR end of each edge — the node `where` is about. For an in-edge that
  // is fromId, which is the whole reason direction had to become a parameter:
  // the far end is not always toId.
  const far: string[] = []
  if (dir === 'out' || dir === 'either') {
    for (const e of await adapter.queryEdges({ relationship, fromId: instance.id })) {
      far.push(e.toId)
    }
  }
  if (dir === 'in' || dir === 'either') {
    for (const e of await adapter.queryEdges({ relationship, toId: instance.id })) {
      far.push(e.fromId)
    }
  }

  // A self-edge is one edge, and 'either' must not count it twice.
  const ends = dir === 'either' ? [...new Set(far)] : far
  if (!where) return ends.length

  // Batch when the adapter offers it — a rule with a `where` used to read one
  // instance per edge, so a rule over a well-connected record was itself N+1.
  const nodes = adapter.getInstances
    ? await adapter.getInstances(ends)
    : (await Promise.all(ends.map((id) => adapter.getInstance(id)))).filter(
        (n): n is Instance => n !== null,
      )

  return nodes.filter((node) => matchesProperties(where, node.data)).length
}
