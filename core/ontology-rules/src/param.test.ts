import { describe, it, expect } from 'vitest'
import type { Instance, FunctionIO } from '@dqa-ai-solutions/ontology-model'
import { ruleFromIR, paramResolver, type ExprNode } from './eval-expr.js'
import { validateRuleSpec, buildRegistry } from './validate-rule.js'
import { validateRuleIRSchema, RULE_SCHEMA_VERSION } from './rule-schema.js'

const N = (data: Record<string, unknown>): Instance => ({ id: 'x', entityType: 'JournalEntry', data, provenance: { source_ref: '', confirmed_by: '', confirmed_at: '' }, source_ref: '', confirmed_by: '', confirmed_at: '' })
const io = { get: async () => null, find: async () => [], neighbors: async () => [] } as unknown as FunctionIO

// cash payment ≥ threshold(param) — threshold is DATA with effective dates (20tr → 5tr from 2025-07-01)
const LAW = [
  { key: 'cash-payment-threshold', value: 20_000_000, effectiveFrom: '2014-01-01', effectiveTo: '2025-07-01' },
  { key: 'cash-payment-threshold', value: 5_000_000, effectiveFrom: '2025-07-01', effectiveTo: '' },
]
const cashRule: { id: string; on: string; severity: string; expr: ExprNode } = {
  id: 'LAW-CASH-THRESHOLD', on: 'JournalEntry', severity: 'critical',
  expr: { op: 'compare', cmp: '>=', left: { op: 'prop', field: 'amount' }, right: { op: 'param', key: 'cash-payment-threshold' } },
}

describe('param — law threshold as effective-dated data', () => {
  it('schema v3 accepts the param op', () => {
    expect(RULE_SCHEMA_VERSION).toBe(4)
    expect(validateRuleIRSchema(cashRule)).toEqual([])
  })

  it('resolves the threshold by as-of date and fires accordingly', async () => {
    const params = paramResolver(LAW)
    const r2025 = ruleFromIR(cashRule as never, { params, asOf: '2025-09-01' }) // threshold = 5tr
    const r2024 = ruleFromIR(cashRule as never, { params, asOf: '2024-09-01' }) // threshold = 20tr
    const pay = N({ amount: 8_000_000 })
    expect(Boolean(await r2025.khi!(pay, io))).toBe(true)  // 8tr ≥ 5tr → fires (2025 rule)
    expect(Boolean(await r2024.khi!(pay, io))).toBe(false) // 8tr < 20tr → no fire (2024 rule)
  })

  it('validateRuleSpec checks the param key against the declared closed set', () => {
    const reg = buildRegistry({ entities: [{ name: 'JournalEntry', properties: [{ name: 'amount' }] }], relationships: [] }, { paramKeys: ['cash-payment-threshold'] })
    expect(validateRuleSpec(cashRule, reg)).toEqual([])
    const bad = { ...cashRule, expr: { ...cashRule.expr, right: { op: 'param', key: 'no-such-key' } } as ExprNode }
    const slots = validateRuleSpec(bad, reg)
    expect(slots.find((s) => s.metaRuleId === 'M-PARAM-REF')?.options).toEqual(['cash-payment-threshold'])
  })

  it('unwired param resolver throws (fails loud, not silent)', async () => {
    const r = ruleFromIR(cashRule as never, {}) // no params
    await expect(r.khi!(N({ amount: 9_000_000 }), io)).rejects.toThrow(/param/)
  })
})
