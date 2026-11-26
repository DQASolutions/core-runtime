import type { ScopedRule, RuleConflict } from './types.js'

// Cổng va-chạm (design §6). Pure: given the candidate rules a client would resolve,
// find SAME-RANK collisions — one rule_id offered at the same layer by ≥2 sources
// with different versions. Runtime resolve() is deterministic, but a same-rank
// collision is genuinely ambiguous config → surface it so a human resolves it once
// (pick a winner / add an override) at subscribe/publish time, never silently.
//
// Cross-layer same rule_id is NOT a conflict — that is precedence (client shadows
// segment shadows base). Same layer + same version is NOT a conflict — identical rule.

export function detectConflicts<IR = unknown>(candidates: ScopedRule<IR>[]): RuleConflict[] {
  const byRule = new Map<string, ScopedRule<IR>[]>()
  for (const c of candidates) {
    const arr = byRule.get(c.ruleId)
    if (arr) arr.push(c)
    else byRule.set(c.ruleId, [c])
  }

  const conflicts: RuleConflict[] = []
  for (const [ruleId, cs] of byRule) {
    const byLayer = new Map<number, ScopedRule<IR>[]>()
    for (const c of cs) {
      const g = byLayer.get(c.layer)
      if (g) g.push(c)
      else byLayer.set(c.layer, [c])
    }
    for (const [layer, group] of byLayer) {
      if (new Set(group.map((g) => g.version)).size > 1) {
        conflicts.push({
          ruleId,
          layer,
          contenders: group.map((g) => ({ version: g.version, source: g.source })).sort((a, b) => a.version - b.version),
        })
      }
    }
  }
  return conflicts.sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : a.layer - b.layer))
}
