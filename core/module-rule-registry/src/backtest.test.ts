import { describe, it, expect } from 'vitest'
import { diffFindings, diffTemplateMembers, affectedRuleIds, overridesToReconfirm, backTestDiff, type BacktestFinding } from './backtest.js'

const f = (instance: string, ruleId: string): BacktestFinding => ({ instance, ruleId })

describe('diffFindings', () => {
  it('added = NEW raised that OLD did not', () => {
    const d = diffFindings([f('i1', 'R-A')], [f('i1', 'R-A'), f('i2', 'R-B')])
    expect(d.added).toEqual([f('i2', 'R-B')])
    expect(d.suppressed).toEqual([])
  })
  it('suppressed = OLD raised that NEW does not (dangerous)', () => {
    const d = diffFindings([f('i1', 'R-A'), f('i2', 'R-B')], [f('i1', 'R-A')])
    expect(d.suppressed).toEqual([f('i2', 'R-B')])
    expect(d.added).toEqual([])
  })
  it('identical → no diff', () => {
    expect(diffFindings([f('i1', 'R-A')], [f('i1', 'R-A')])).toEqual({ added: [], suppressed: [] })
  })
  it('per (instance, rule) — same rule other instance is distinct', () => {
    const d = diffFindings([f('i1', 'R-A')], [f('i2', 'R-A')])
    expect(d.added).toEqual([f('i2', 'R-A')])
    expect(d.suppressed).toEqual([f('i1', 'R-A')])
  })
  it('results are sorted (deterministic)', () => {
    const d = diffFindings([], [f('i2', 'R-B'), f('i1', 'R-A'), f('i1', 'R-B')])
    expect(d.added).toEqual([f('i1', 'R-A'), f('i1', 'R-B'), f('i2', 'R-B')])
  })
})

describe('diffTemplateMembers', () => {
  it('classifies added / removed / changed by rule_id + version', () => {
    const oldM = [{ ruleId: 'R-KEEP', ruleVersion: 1 }, { ruleId: 'R-GONE', ruleVersion: 1 }, { ruleId: 'R-CHG', ruleVersion: 1 }]
    const newM = [{ ruleId: 'R-KEEP', ruleVersion: 1 }, { ruleId: 'R-NEW', ruleVersion: 1 }, { ruleId: 'R-CHG', ruleVersion: 2 }]
    expect(diffTemplateMembers(oldM, newM)).toEqual({ added: ['R-NEW'], removed: ['R-GONE'], changed: ['R-CHG'] })
  })
})

describe('affectedRuleIds / overridesToReconfirm', () => {
  it('affected = removed + changed', () => {
    expect(affectedRuleIds({ added: ['R-NEW'], removed: ['R-GONE'], changed: ['R-CHG'] })).toEqual(['R-CHG', 'R-GONE'])
  })
  it('override re-confirm = client overrides that touch an affected rule', () => {
    const affected = ['R-CHG', 'R-GONE']
    expect(overridesToReconfirm(affected, ['R-CHG', 'R-KEEP', 'R-OTHER'])).toEqual(['R-CHG'])
    expect(overridesToReconfirm(affected, ['R-KEEP'])).toEqual([])
  })
})

describe('backTestDiff — affected-rules-only + injectable runFindings', () => {
  const R = (id: string) => ({ ruleId: id, ir: { id } as any })

  it('unchanged rules are NEVER evaluated; a removed rule → suppressed', async () => {
    const evaluated: string[] = []
    const runFindings = async (irs: any[]) => {
      irs.forEach((i) => evaluated.push(i.id))
      return irs.flatMap((i) => (i.id === 'R-DROP' ? [{ instance: 'i1', ruleId: 'R-DROP' }] : []))
    }
    const res = await backTestDiff({
      oldRules: [R('R-KEEP'), R('R-DROP')], newRules: [R('R-KEEP')],
      oldMembers: [{ ruleId: 'R-KEEP', ruleVersion: 1 }, { ruleId: 'R-DROP', ruleVersion: 1 }],
      newMembers: [{ ruleId: 'R-KEEP', ruleVersion: 1 }],
    }, runFindings)
    expect(res.memberDelta.removed).toEqual(['R-DROP'])
    expect(evaluated).toEqual(['R-DROP']) // R-KEEP không đổi → KHÔNG chạy engine
    expect(res.findingsDiff.suppressed).toEqual([{ instance: 'i1', ruleId: 'R-DROP' }])
    expect(res.findingsDiff.added).toEqual([])
  })

  it('an added rule → added findings', async () => {
    const runFindings = async (irs: any[]) => irs.map((i) => ({ instance: 'i1', ruleId: i.id }))
    const res = await backTestDiff({
      oldRules: [R('R-A')], newRules: [R('R-A'), R('R-NEW')],
      oldMembers: [{ ruleId: 'R-A', ruleVersion: 1 }], newMembers: [{ ruleId: 'R-A', ruleVersion: 1 }, { ruleId: 'R-NEW', ruleVersion: 1 }],
    }, runFindings)
    expect(res.findingsDiff.added).toEqual([{ instance: 'i1', ruleId: 'R-NEW' }])
    expect(res.findingsDiff.suppressed).toEqual([])
  })

  it('a changed rule is evaluated at BOTH versions (old→suppressed, new→added)', async () => {
    const runFindings = async (irs: any[]) => irs.flatMap((i) => (i.v === 1 ? [{ instance: 'i1', ruleId: 'R-CHG' }] : [{ instance: 'i2', ruleId: 'R-CHG' }]))
    const res = await backTestDiff({
      oldRules: [{ ruleId: 'R-CHG', ir: { id: 'R-CHG', v: 1 } }], newRules: [{ ruleId: 'R-CHG', ir: { id: 'R-CHG', v: 2 } }],
      oldMembers: [{ ruleId: 'R-CHG', ruleVersion: 1 }], newMembers: [{ ruleId: 'R-CHG', ruleVersion: 2 }],
    }, runFindings)
    expect(res.memberDelta.changed).toEqual(['R-CHG'])
    expect(res.findingsDiff.suppressed).toEqual([{ instance: 'i1', ruleId: 'R-CHG' }])
    expect(res.findingsDiff.added).toEqual([{ instance: 'i2', ruleId: 'R-CHG' }])
  })

  it('identical versions → engine NOT called, empty diff', async () => {
    let called = 0
    const res = await backTestDiff({
      oldRules: [R('R-A')], newRules: [R('R-A')], oldMembers: [{ ruleId: 'R-A', ruleVersion: 1 }], newMembers: [{ ruleId: 'R-A', ruleVersion: 1 }],
    }, async () => { called++; return [] })
    expect(called).toBe(0)
    expect(res.findingsDiff).toEqual({ added: [], suppressed: [] })
  })
})
