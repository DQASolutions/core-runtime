// @impl S008-AC-001, S008-AC-002, S008-AC-005, S008-AC-006, S008-AC-007, S008-AC-009, S008-AC-010, S008-AC-011
// Rule & Evaluation context (Layer 2) — the heart (source-spec §3.5).
// For a scope: take every enabled rule that applies → interpret its condition
// per candidate instance → emit a Flag (with a best-effort trace) when the
// condition holds. Flags are computed on demand, never persisted (no event
// sourcing — spec §7).
//
// DoS guards (SEC-OTHER-08/09):
const MAX_CANDIDATES = 10_000  // max instances evaluated per evaluateRules() call

import {
  type CompareOp,
  type EvalScope,
  type Flag,
  type Instance,
  type RuleDef,
  type TraversalResult,
  ontologyError,
} from '../../types/index.js'
import type { StorageAdapter } from '../../ports/storage-adapter.js'
import { matchesProperties } from '../../shared/condition-match.js'
import { evaluateRuleCondition } from './condition-interpreter.js'
import { planTraversal } from '../graph/traversal-planner.js'

function render(template: string, instance: Instance): string {
  return template.replace(/\{(\w+)\}/g, (_m, key: string) => {
    if (key === 'id') return instance.id
    if (key === 'entityType') return instance.entityType
    const v = instance.data[key]
    return v === undefined ? `{${key}}` : String(v)
  })
}

function toNumber(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function compareNum(a: number, cmp: CompareOp, b: number): boolean {
  switch (cmp) {
    case '=': return a === b
    case '!=': return a !== b
    case '>': return a > b
    case '<': return a < b
    case '>=': return a >= b
    case '<=': return a <= b
    default: return false
  }
}

/**
 * AGGREGATE evaluation: group candidates by the `groupBy` property values,
 * sum `field` (or count), and flag EVERY instance in a group whose aggregate
 * satisfies `cmp threshold`.
 */
function aggregateFlags(rule: RuleDef, candidates: Instance[]): Flag[] {
  const cond = rule.condition
  if (cond.op !== 'aggregate') return []

  const groups = new Map<string, Instance[]>()
  for (const inst of candidates) {
    const key = cond.groupBy.map((f) => JSON.stringify(inst.data[f] ?? null)).join('|')
    const arr = groups.get(key)
    if (arr) arr.push(inst)
    else groups.set(key, [inst])
  }

  const out: Flag[] = []
  for (const members of groups.values()) {
    const agg = cond.fn === 'count'
      ? members.length
      : members.reduce((sum, m) => sum + toNumber(m.data[cond.field as string]), 0)
    if (!compareNum(agg, cond.cmp, cond.threshold)) continue
    for (const inst of members) {
      out.push({
        ruleId: rule.id,
        ruleName: rule.name,
        instanceId: inst.id,
        entityType: inst.entityType,
        severity: rule.severity,
        message: render(rule.message, inst),
        trace: { start: inst.id, path: [], direction: 'forward', paths: [], nodes: [inst], edges: [] },
      })
    }
  }
  return out
}

/** Collect the relationship name a rule references, for a best-effort trace. */
function firstRelationship(cond: RuleDef['condition']): string | undefined {
  switch (cond.op) {
    case 'exists':
    case 'absent':
    case 'count':
      return cond.relationship
    case 'not':
      return firstRelationship(cond.clause)
    case 'and':
    case 'or':
      for (const c of cond.clauses) {
        const r = firstRelationship(c)
        if (r) return r
      }
      return undefined
    default:
      return undefined
  }
}

// @impl BR-010
export async function evaluateRules(scope: EvalScope, adapter: StorageAdapter): Promise<Flag[]> {
  let rules = (await adapter.queryRules({ enabled: true })).filter((r) => r.enabled)
  if (rules.length === 0) return []

  // FR-N01: when scope.entityType is present, evaluate only rules whose appliesTo matches
  if (scope.entityType !== undefined) {
    rules = rules.filter((r) => r.appliesTo === scope.entityType)
    if (rules.length === 0) return []
  }

  const flags: Flag[] = []

  for (const rule of rules) {
    const entityType = scope.entityType ?? rule.appliesTo
    const candidates = await resolveCandidates(entityType, scope, adapter)

    // AGGREGATE rules group candidates and flag whole groups — a different pass
    // than the per-instance condition interpreter.
    if (rule.condition.op === 'aggregate') {
      flags.push(...aggregateFlags(rule, candidates))
      continue
    }

    for (const inst of candidates) {
      // FR-E03: malformed rule condition skips this rule; evaluation continues for others
      let holds: boolean
      try {
        holds = await evaluateRuleCondition(rule.condition, inst, adapter)
      } catch {
        continue
      }
      if (!holds) continue
      // FR-D01/FR-D04: trace is always present; fall back to a minimal single-node result (FR-E06)
      const trace = (await buildTrace(rule, inst, adapter)) ?? {
        start: inst.id,
        path: [],
        direction: 'forward' as const,
        paths: [],
        nodes: [inst],
        edges: [],
      }
      const flag: Flag = {
        ruleId: rule.id,
        ruleName: rule.name,
        instanceId: inst.id,
        entityType: inst.entityType,
        severity: rule.severity,
        message: render(rule.message, inst),
        trace,
      }
      flags.push(flag)
    }
  }
  return flags
}

async function resolveCandidates(
  entityType: string,
  scope: EvalScope,
  adapter: StorageAdapter,
): Promise<Instance[]> {
  let candidates: Instance[]
  if (scope.ids && scope.ids.length > 0) {
    candidates = []
    for (const id of scope.ids) {
      const i = await adapter.getInstance(id)
      if (i && i.entityType === entityType) candidates.push(i)
    }
  } else {
    candidates = await adapter.queryInstances(entityType, null)
  }
  if (scope.where) candidates = candidates.filter((c) => matchesProperties(scope.where!, c.data))
  if (scope.period) {
    const { from, to } = scope.period
    candidates = candidates.filter((c) => c.confirmed_at >= from && c.confirmed_at <= to)
  }
  // SEC-OTHER-09: cap candidates to prevent unbounded evaluation
  if (candidates.length > MAX_CANDIDATES) {
    throw ontologyError(
      'EVALUATION_LIMIT_EXCEEDED',
      `evaluateRules() candidate set of ${candidates.length} instances exceeds the maximum of ${MAX_CANDIDATES}; narrow the scope with entityType, ids, or where`,
    )
  }
  return candidates
}

async function buildTrace(
  rule: RuleDef,
  inst: Instance,
  adapter: StorageAdapter,
): Promise<TraversalResult | undefined> {
  const rel = firstRelationship(rule.condition)
  if (!rel) return undefined
  try {
    return await planTraversal({ start: inst.id, path: [rel], direction: 'forward' }, adapter)
  } catch {
    return undefined
  }
}
