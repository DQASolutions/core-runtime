// Rules grouped by the entity type they apply to, and the later-wins merge of layered specs.
// Pure — the file loaders (`loadFunctions`, `loadRuleStore`, in @dqa-ai-solutions/ontology-runtime)
// and the in-memory (registry) path share these, so the override semantics live in one place.
import type { CollectedSpecs, RuleSpec } from './fn.js'
import { ruleFromIR, type RuleIR, type RuleRuntime } from './eval-expr.js'
import { assertRuleIRSchema } from './rule-schema.js'

/** Rules grouped by the entity type they apply to (the `check` sweep map). */
export type RulesByType = Record<string, RuleSpec[]>

/**
 * Collapse layered specs so a LATER layer wins: rules deduped by `id`,
 * computes/actions by `name`, keeping the last occurrence. (Base specs are
 * collected first, overlays last, so overlays override.) Pure — unit-testable
 * without disk; the override semantics live here, not in the import loop.
 */
export function overrideLast(c: CollectedSpecs): CollectedSpecs {
  const lastBy = <T>(arr: T[], key: (x: T) => string): T[] => [...new Map(arr.map((x) => [key(x), x])).values()]
  const rulesByType: RulesByType = {}
  for (const [t, rs] of Object.entries(c.rulesByType)) rulesByType[t] = lastBy(rs, (r) => r.id)
  return { computes: lastBy(c.computes, (x) => x.name), actions: lastBy(c.actions, (x) => x.name), rulesByType }
}

/** Group compiled specs by entity type, later-wins by `id` (the `check` sweep map).
 *  Pure — shared by the file loader and the in-memory (registry) loader. */
export function groupRulesByType(specs: RuleSpec[]): RulesByType {
  const lastBy = <T>(arr: T[], key: (x: T) => string): T[] => [...new Map(arr.map((x) => [key(x), x])).values()]
  const byType: RulesByType = {}
  for (const r of specs) (byType[r.on] ??= []).push(r)
  for (const t of Object.keys(byType)) byType[t] = lastBy(byType[t], (r) => r.id)
  return byType
}

/**
 * IN-MEMORY twin of {@link loadRuleStore}: compile an already-resolved list of
 * {@link RuleIR} (e.g. from `@dqa-ai-solutions/module-rule-registry` `resolveForClient`) into the check
 * sweep map — same schema gate, same active-only filter, same group/override-by-id.
 * This is the seam that lets the `check` step run RDB-sourced rules WITHOUT this
 * module depending on the registry: the wiring layer resolves rules and passes the
 * IRs in. `label` gives error context for the schema gate (default: index + id).
 */
export function rulesByTypeFromIR(
  irs: RuleIR[],
  rt: RuleRuntime = {},
  label: (ir: RuleIR, i: number) => string = (ir, i) =>
    `[${i}]${ir && typeof ir === 'object' && 'id' in ir ? ` id=${(ir as RuleIR).id}` : ''}`,
): RulesByType {
  const specs: RuleSpec[] = []
  irs.forEach((ir, i) => {
    // FIXED-schema gate FIRST — malformed IR fails loud, never silently dropped.
    assertRuleIRSchema(ir, label(ir, i))
    if (ir.status && ir.status !== 'active') return
    specs.push(ruleFromIR(ir, rt))
  })
  return groupRulesByType(specs)
}

/** Merge rule maps (e.g. function rules + IR-store rules) into one sweep map.
 *  Later maps override earlier by rule id within each type. */
export function mergeRulesByType(...maps: RulesByType[]): RulesByType {
  const lastBy = <T>(arr: T[], key: (x: T) => string): T[] => [...new Map(arr.map((x) => [key(x), x])).values()]
  const out: RulesByType = {}
  for (const m of maps) for (const [t, rs] of Object.entries(m)) out[t] = [...(out[t] ?? []), ...rs]
  for (const t of Object.keys(out)) out[t] = lastBy(out[t], (r) => r.id)
  return out
}
