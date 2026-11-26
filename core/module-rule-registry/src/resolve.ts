import { createHash } from 'node:crypto'
import type {
  ScopedRule,
  RuleOverride,
  ResolvedRule,
  ResolvedManifest,
  ResolveResult,
} from './types.js'
import { OVERRIDE_RANK } from './types.js'
import type { ResolveInputs } from './store.js'

// resolve() — the pure heart of the registry (design §4). Given candidate rules
// tagged by layer + per-client overrides, produce the merged rule-set that runs,
// plus an immutable manifest (lockfile). NO DB, NO fact access — unit-testable.
//
// Precedence (design §4 stack): later layer wins by rule_id (same idiom as
// @dqa-ai-solutions/ontology-rules `overrideLast`/`lastBy`); overrides always win last.

/** Deterministic JSON: object keys sorted recursively, so the hash is stable
 *  regardless of key insertion order. */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(',')}}`
}

function hashResolved<IR>(rules: ResolvedRule<IR>[]): string {
  const canon = rules.map((r) => ({ ruleId: r.ruleId, version: r.version, ir: r.ir }))
  return createHash('sha256').update(canonicalStringify(canon)).digest('hex')
}

/** Merge candidate layers + apply overrides → resolved rule-set + manifest. Pure. */
export function resolveRuleSet<IR = unknown>(inputs: ResolveInputs<IR>): ResolveResult<IR> {
  const { candidates, overrides } = inputs

  // 1) Layer precedence: sort by layer asc, then dedup by ruleId keeping the LAST
  //    (highest layer) — client shadows template, template shadows base. Tie-break
  //    within a layer is DETERMINISTIC (version desc, then source ownerId) so a
  //    same-rank collision never resolves arbitrarily — surface it via
  //    detectConflicts() at config time, but runtime is always reproducible.
  const ordered = [...candidates].sort((a, b) => {
    if (a.layer !== b.layer) return a.layer - b.layer
    if (a.version !== b.version) return a.version - b.version
    const oa = String(a.source.ownerId), ob = String(b.source.ownerId)
    return oa < ob ? -1 : oa > ob ? 1 : 0
  })
  const byId = new Map<string, ScopedRule<IR>>()
  for (const r of ordered) byId.set(r.ruleId, r)

  // 2) ĐIỀU CHỈNH (by rule_id — sống sót qua mọi lần bump template). Firm trước, client sau ⇒
  //    client thắng. KHÔNG có nhánh nào làm luật rơi khỏi tập: "không áp luật" là MIỄN TRỪ, xảy
  //    ra ở tầng KẾT QUẢ với dấu vết (§12.2). Tập luật resolve ra LUÔN đầy đủ.
  const ordered0 = [...overrides].sort((a, b) => OVERRIDE_RANK[a.scope] - OVERRIDE_RANK[b.scope])
  const overrideById = new Map<string, RuleOverride[]>()
  for (const o of ordered0) {
    const arr = overrideById.get(o.ruleId) ?? []
    arr.push(o)
    overrideById.set(o.ruleId, arr)
  }
  const overridesApplied: ResolvedManifest['overridesApplied'] = []
  const resolved: ResolvedRule<IR>[] = []
  const params: Record<string, number> = {}

  for (const rule of byId.values()) {
    let ir = rule.ir
    for (const ov of overrideById.get(rule.ruleId) ?? []) {
      if (ov.params) {
        Object.assign(params, ov.params)   // scope sau đè scope trước (firm → client)
        overridesApplied.push({ ruleId: rule.ruleId, kind: 'params', scope: ov.scope })
      }
      if (ov.patch && ir !== null && typeof ir === 'object') {
        ir = { ...(ir as Record<string, unknown>), ...ov.patch } as IR
        overridesApplied.push({ ruleId: rule.ruleId, kind: 'patched', scope: ov.scope })
      }
    }
    resolved.push({ ruleId: rule.ruleId, version: rule.version, ir, source: rule.source })
  }

  // 3) Deterministic order (by ruleId) for a stable manifest + hash.
  resolved.sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0))
  overridesApplied.sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0))

  const manifest: ResolvedManifest = {
    rules: resolved.map((r) => ({ ruleId: r.ruleId, version: r.version, source: r.source })),
    overridesApplied,
    hash: hashResolved(resolved),
  }
  // `params` = lớp ĐÈ lên law_parameter@asOf. App dựng ParamResolver xếp lớp: override ▸ law.
  return { rules: resolved, manifest, params }
}
