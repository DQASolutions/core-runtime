import { describe, it, expect } from 'vitest'
import { detectConflicts } from './conflicts.js'
import { resolveRuleSet } from './resolve.js'
import { LAYER, type ScopedRule } from './types.js'

type IR = Record<string, unknown>
// two segment templates at the SAME layer (LAYER.segment) but different owners
const seg = (ruleId: string, version: number, owner: string, ir: IR = {}): ScopedRule<IR> => ({
  ruleId, version, ir, layer: LAYER.segment, source: { kind: 'segment-template', ownerId: owner, templateVersion: version },
})
const base = (ruleId: string, version: number, ir: IR = {}): ScopedRule<IR> => ({
  ruleId, version, ir, layer: LAYER.base, source: { kind: 'base-template', ownerId: 'base', templateVersion: version },
})

describe('detectConflicts — same-rank collisions only', () => {
  it('distinct rule_ids → no conflict', () => {
    expect(detectConflicts([base('R-A', 1), seg('R-B', 1, 'seg1')])).toEqual([])
  })

  it('same rule_id across DIFFERENT layers → precedence, NOT a conflict', () => {
    expect(detectConflicts([base('R-A', 1), seg('R-A', 2, 'seg1')])).toEqual([])
  })

  it('same layer + same version → identical, NOT a conflict', () => {
    expect(detectConflicts([seg('R-A', 3, 'seg1'), seg('R-A', 3, 'seg2')])).toEqual([])
  })

  it('same layer + DIFFERENT versions → CONFLICT with contenders', () => {
    const c = detectConflicts([seg('R-A', 2, 'manufacturing'), seg('R-A', 5, 'export')])
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ ruleId: 'R-A', layer: LAYER.segment })
    expect(c[0].contenders.map((x) => x.version)).toEqual([2, 5]) // sorted
    expect(c[0].contenders.map((x) => x.source.ownerId).sort()).toEqual(['export', 'manufacturing'])
  })

  it('conflicts are sorted by ruleId', () => {
    const c = detectConflicts([seg('R-Z', 1, 's1'), seg('R-Z', 2, 's2'), seg('R-A', 1, 's1'), seg('R-A', 2, 's2')])
    expect(c.map((x) => x.ruleId)).toEqual(['R-A', 'R-Z'])
  })
})

describe('resolveRuleSet — deterministic on same-layer tie (no arbitrary last-win)', () => {
  it('same-layer collision resolves to highest version, order-independent', () => {
    const a = resolveRuleSet<IR>({ candidates: [seg('R-A', 2, 'm', { v: 2 }), seg('R-A', 5, 'x', { v: 5 })], overrides: [] })
    const b = resolveRuleSet<IR>({ candidates: [seg('R-A', 5, 'x', { v: 5 }), seg('R-A', 2, 'm', { v: 2 })], overrides: [] })
    expect(a.rules).toHaveLength(1)
    expect(a.rules[0]).toMatchObject({ version: 5, ir: { v: 5 } })
    expect(a.manifest.hash).toBe(b.manifest.hash) // same result regardless of input order
  })
})
