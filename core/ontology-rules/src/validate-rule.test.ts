import { describe, it, expect } from 'vitest'
import { validateRuleSpec, buildRegistry, type PartialRuleSpec } from './validate-rule.js'
import type { ExprNode } from './eval-expr.js'

const ontology = {
  entities: [
    { name: 'AccountBalance', properties: [{ name: 'closingDebit' }, { name: 'closingCredit' }, { name: 'normalBalance' }] },
    { name: 'SubledgerEntry', properties: [{ name: 'closingBalance' }, { name: 'side' }] },
  ],
  relationships: [
    { name: 'accountBalance_subledger', from: 'AccountBalance', to: 'SubledgerEntry' },
  ],
}
const reg = buildRegistry(ontology, { computes: ['subledgerTotal'], existingRuleIds: ['R-EXISTING'] })

// Σ over FILTERED subledger neighbours = the per-side aggregation, as data.
const debitSideSum: ExprNode = {
  op: 'sum',
  set: {
    op: 'filter',
    set: { op: 'rel', rel: 'accountBalance_subledger' },
    where: { op: 'compare', cmp: '=', left: { op: 'prop', field: 'side' }, right: { op: 'lit', value: 'debit' } },
  },
  value: { op: 'prop', field: 'closingBalance' },
}

describe('validate-rule — completeness + closed options', () => {
  it('a complete draft validates to [] (ready for review)', () => {
    const spec: PartialRuleSpec = {
      ruleId: 'R-NEW', appliesTo: 'AccountBalance', severity: 'critical',
      expr: { op: 'compare', cmp: '!=', left: debitSideSum, right: { op: 'prop', field: 'closingDebit' } },
    }
    expect(validateRuleSpec(spec, reg)).toEqual([])
  })

  it('structural holes surface as slots with closed options', () => {
    const slots = validateRuleSpec({ appliesTo: 'Nope', expr: null }, reg)
    const byId = Object.fromEntries(slots.map((s) => [s.metaRuleId, s]))
    expect(byId['M-SEVERITY'].options).toEqual(['critical', 'warning', 'info'])
    expect(byId['M-APPLIES-TO'].options).toEqual(['AccountBalance', 'SubledgerEntry'])
    expect(byId['M-HAS-CONDITION']).toBeTruthy()
  })

  it('existing rule id is rejected', () => {
    const slots = validateRuleSpec({ ruleId: 'R-EXISTING', appliesTo: 'AccountBalance', severity: 'info', expr: { op: 'exists', set: { op: 'rel', rel: 'accountBalance_subledger' } } }, reg)
    expect(slots.map((s) => s.metaRuleId)).toContain('M-RULE-ID-UNIQUE')
  })

  it('unknown property on the ROOT type → options are root props', () => {
    const slots = validateRuleSpec({ ruleId: 'R', appliesTo: 'AccountBalance', severity: 'info', expr: { op: 'compare', cmp: '>', left: { op: 'prop', field: 'nope' }, right: { op: 'lit', value: 0 } } }, reg)
    const s = slots.find((x) => x.metaRuleId === 'M-PROP-REF')!
    expect(s.slot).toBe('expr.left.field')
    expect(s.options).toEqual(['closingDebit', 'closingCredit', 'normalBalance'])
  })

  it('SCOPE TRACKING: prop inside a sum-over-rel is checked against the NEIGHBOUR type', () => {
    // closingBalance IS valid on SubledgerEntry ⇒ no slot
    const ok = validateRuleSpec({ ruleId: 'R', appliesTo: 'AccountBalance', severity: 'info', expr: { op: 'exists', set: { op: 'filter', set: { op: 'rel', rel: 'accountBalance_subledger' }, where: { op: 'compare', cmp: '=', left: { op: 'prop', field: 'closingBalance' }, right: { op: 'lit', value: 0 } } } } }, reg)
    expect(ok).toEqual([])

    // closingDebit is a property of AccountBalance, NOT SubledgerEntry — inside the
    // sum's element scope it must fail, and the options must be SubledgerEntry's props.
    const bad = validateRuleSpec({ ruleId: 'R', appliesTo: 'AccountBalance', severity: 'info', expr: { op: 'sum', set: { op: 'rel', rel: 'accountBalance_subledger' }, value: { op: 'prop', field: 'closingDebit' } } as ExprNode }, reg)
    const s = bad.find((x) => x.metaRuleId === 'M-PROP-REF')!
    expect(s.message).toContain('SubledgerEntry')
    expect(s.options).toEqual(['closingBalance', 'side'])
  })

  it('unknown relationship → options are rels usable on that type', () => {
    const slots = validateRuleSpec({ ruleId: 'R', appliesTo: 'AccountBalance', severity: 'info', expr: { op: 'exists', set: { op: 'rel', rel: 'nope' } } }, reg)
    const s = slots.find((x) => x.metaRuleId === 'M-REL-REF')!
    expect(s.options).toEqual(['accountBalance_subledger'])
  })

  it('unknown compute → escalate needs-primitive', () => {
    const slots = validateRuleSpec({ ruleId: 'R', appliesTo: 'AccountBalance', severity: 'info', expr: { op: 'compare', cmp: '>', left: { op: 'call', name: 'notARealCompute' } as ExprNode, right: { op: 'lit', value: 0 } } }, reg)
    const s = slots.find((x) => x.metaRuleId === 'M-CALL-REF')!
    expect(s.escalate).toBe('needs-primitive')
    expect(s.options).toEqual(['subledgerTotal'])
  })

  it('a node with no op is flagged', () => {
    const slots = validateRuleSpec({ ruleId: 'R', appliesTo: 'AccountBalance', severity: 'info', expr: {} as ExprNode }, reg)
    expect(slots.map((s) => s.metaRuleId)).toContain('M-HAS-OP')
  })
})

describe('validate-rule — buildRegistry', () => {
  it('relationships are navigable from either endpoint', () => {
    expect(reg.relationshipTarget('AccountBalance', 'accountBalance_subledger')).toBe('SubledgerEntry')
    expect(reg.relationshipTarget('SubledgerEntry', 'accountBalance_subledger')).toBe('AccountBalance')
    expect(reg.relationshipsOf('SubledgerEntry')).toEqual(['accountBalance_subledger'])
    expect(reg.relationshipTarget('AccountBalance', 'nope')).toBeUndefined()
  })
})
