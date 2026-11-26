import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import type { Instance, FunctionIO } from '@dqa-ai-solutions/ontology-sdk'
import { loadRuleStore, rulesByTypeFromIR, mergeRulesByType, type RulesByType } from './load-functions.js'
import type { RuleIR } from './eval-expr.js'
import { rule } from './fn.js'

const dir = path.join(os.tmpdir(), 'fos-rule-store-test')
const io = { get: async () => null, find: async () => [], neighbors: async () => [] } as unknown as FunctionIO
const inst = (data: Record<string, unknown>): Instance =>
  ({ id: 'x', entityType: 'AccountBalance', data, provenance: { source_ref: '', confirmed_by: '', confirmed_at: '' }, source_ref: '', confirmed_by: '', confirmed_at: '' })

beforeAll(async () => {
  await fs.ensureDir(dir)
  // an ACTIVE rule (runs), a DRAFT (skipped), and a FILE with an array of rules
  await fs.writeJson(path.join(dir, 'active.json'), {
    id: 'R-A', on: 'AccountBalance', severity: 'warning', status: 'active',
    expr: { op: 'compare', cmp: '<', left: { op: 'prop', field: 'closingDebit' }, right: { op: 'lit', value: 0 } },
  })
  await fs.writeJson(path.join(dir, 'draft.json'), {
    id: 'R-DRAFT', on: 'AccountBalance', severity: 'critical', status: 'draft',
    expr: { op: 'lit', value: true },
  })
  await fs.writeJson(path.join(dir, 'arr.json'), [
    { id: 'R-B', on: 'JournalEntry', severity: 'info', expr: { op: 'lit', value: false } }, // no status ⇒ active
  ])
})
afterAll(async () => { await fs.remove(dir) })

describe('loadRuleStore — JSON rule store → runnable rules', () => {
  it('loads active rules (skips drafts), groups by entity type', async () => {
    const byType = await loadRuleStore(dir)
    expect(byType['AccountBalance'].map((r) => r.id)).toEqual(['R-A'])
    expect(byType['JournalEntry'].map((r) => r.id)).toEqual(['R-B'])
    expect(Object.values(byType).flat().map((r) => r.id)).not.toContain('R-DRAFT')
  })

  it('a loaded rule actually runs (its khi evaluates the IR)', async () => {
    const byType = await loadRuleStore(dir)
    const r = byType['AccountBalance'][0]
    expect(await r.khi!(inst({ closingDebit: 100 }), io)).toBe(false)
    expect(await r.khi!(inst({ closingDebit: -1 }), io)).toBe(true)
  })

  it('missing dir ⇒ empty map (no throw)', async () => {
    expect(await loadRuleStore(path.join(dir, 'does-not-exist'))).toEqual({})
  })
})

describe('rulesByTypeFromIR — in-memory (registry) twin of loadRuleStore', () => {
  const irs: RuleIR[] = [
    { id: 'R-A', on: 'AccountBalance', severity: 'warning', status: 'active',
      expr: { op: 'compare', cmp: '<', left: { op: 'prop', field: 'closingDebit' }, right: { op: 'lit', value: 0 } } } as RuleIR,
    { id: 'R-DRAFT', on: 'AccountBalance', severity: 'critical', status: 'draft', expr: { op: 'lit', value: true } } as RuleIR,
    { id: 'R-B', on: 'JournalEntry', severity: 'info', expr: { op: 'lit', value: false } } as RuleIR,
  ]

  it('compiles active IR (skips drafts), groups by type', () => {
    const byType = rulesByTypeFromIR(irs)
    expect(byType['AccountBalance'].map((r) => r.id)).toEqual(['R-A'])
    expect(byType['JournalEntry'].map((r) => r.id)).toEqual(['R-B'])
    expect(Object.values(byType).flat().map((r) => r.id)).not.toContain('R-DRAFT')
  })

  it('a compiled rule actually runs', async () => {
    const r = rulesByTypeFromIR(irs)['AccountBalance'][0]
    expect(await r.khi!(inst({ closingDebit: 100 }), io)).toBe(false)
    expect(await r.khi!(inst({ closingDebit: -1 }), io)).toBe(true)
  })

  it('later IR overrides earlier by id within a type (registry precedence)', () => {
    const withOverride: RuleIR[] = [
      ...irs,
      { id: 'R-A', on: 'AccountBalance', severity: 'warning', status: 'active', expr: { op: 'lit', value: false } } as RuleIR,
    ]
    const byType = rulesByTypeFromIR(withOverride)
    expect(byType['AccountBalance']).toHaveLength(1) // R-A deduped, last wins
  })

  it('PARITY: same IR via file store and in-memory give the same rule ids', async () => {
    const fromFiles = await loadRuleStore(dir)
    const fromMem = rulesByTypeFromIR(irs)
    const ids = (m: RulesByType) => Object.fromEntries(Object.entries(m).map(([t, rs]) => [t, rs.map((r) => r.id).sort()]))
    expect(ids(fromMem)).toEqual(ids(fromFiles))
  })

  it('malformed IR fails loud (schema gate)', () => {
    expect(() => rulesByTypeFromIR([{ id: 'BAD', on: 'X' } as RuleIR])).toThrow()
  })
})

describe('mergeRulesByType — function rules + IR rules in one sweep', () => {
  it('merges maps and dedupes by id within a type (later wins)', () => {
    const fnRules: RulesByType = { AccountBalance: [rule({ on: 'AccountBalance', id: 'R-A', khi: () => false })] }
    const irRules: RulesByType = { AccountBalance: [rule({ on: 'AccountBalance', id: 'R-A', khi: () => true })], JournalEntry: [rule({ on: 'JournalEntry', id: 'R-B', khi: () => false })] }
    const merged = mergeRulesByType(fnRules, irRules)
    expect(merged['AccountBalance'].length).toBe(1) // R-A deduped
    expect(merged['JournalEntry'].map((r) => r.id)).toEqual(['R-B'])
  })
})
