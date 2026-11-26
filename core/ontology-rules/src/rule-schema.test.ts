import { describe, it, expect } from 'vitest'
import { validateRuleIRSchema, validateExprSchema, assertRuleIRSchema, RuleSchemaError, ruleJsonSchema, OP_SCHEMA, RULE_SCHEMA_VERSION } from './rule-schema.js'
import { ruleFromIR } from './eval-expr.js'

const ok = { id: 'R-A', on: 'AccountBalance', severity: 'warning', status: 'active',
  expr: { op: 'compare', cmp: '<', left: { op: 'prop', field: 'closingDebit' }, right: { op: 'lit', value: 0 } } }

describe('rule-schema — the fixed contract accepts conforming rules', () => {
  it('a well-formed rule has no schema errors', () => {
    expect(validateRuleIRSchema(ok)).toEqual([])
  })
  it('ruleFromIR compiles a conforming rule', () => {
    expect(ruleFromIR(ok as never).id).toBe('R-A')
  })
})

describe('rule-schema — REJECTS anything outside the contract', () => {
  it('unknown op', () => {
    const e = validateExprSchema({ op: 'frobnicate', x: 1 })
    expect(e[0].message).toMatch(/unknown op "frobnicate"/)
  })
  it('unexpected field on a known op (additionalProperties: false)', () => {
    const e = validateExprSchema({ op: 'lit', value: 1, sneaky: true })
    expect(e.some((x) => /unexpected field "sneaky"/.test(x.message))).toBe(true)
  })
  it('missing required field', () => {
    const e = validateExprSchema({ op: 'compare', left: { op: 'lit', value: 1 } }) // no cmp, no right
    expect(e.some((x) => x.path === 'expr.cmp')).toBe(true)
    expect(e.some((x) => x.path === 'expr.right')).toBe(true)
  })
  it('wrong field type (cmp not in the enum)', () => {
    const e = validateExprSchema({ op: 'compare', cmp: '≈', left: { op: 'lit', value: 1 }, right: { op: 'lit', value: 2 } })
    expect(e.some((x) => x.path === 'expr.cmp')).toBe(true)
  })
  it('bad envelope: missing id/on, bad severity, unknown field', () => {
    const e = validateRuleIRSchema({ severity: 'huge', frobnicate: 1, expr: { op: 'self' } })
    const paths = e.map((x) => x.path)
    expect(paths).toContain('id')
    expect(paths).toContain('on')
    expect(paths).toContain('severity')
    expect(paths).toContain('frobnicate')
  })
  it('unsupported schemaVersion is rejected', () => {
    const e = validateRuleIRSchema({ ...ok, schemaVersion: 999 })
    expect(e.some((x) => x.path === 'schemaVersion')).toBe(true)
  })
  it('ruleFromIR THROWS on a non-conforming rule (gate before run)', () => {
    expect(() => ruleFromIR({ on: 'X', id: 'R', expr: { op: 'nope' } } as never)).toThrow(RuleSchemaError)
  })
  it('nested unknown op is caught deep in the tree', () => {
    const e = validateRuleIRSchema({ id: 'R', on: 'X', expr: { op: 'and', children: [{ op: 'lit', value: true }, { op: 'kaboom' }] } })
    expect(e.some((x) => x.path === 'expr.children[1].op')).toBe(true)
  })
})

describe('rule-schema — published JSON Schema is generated from the same table', () => {
  it('one oneOf variant per op, version pinned', () => {
    const s = ruleJsonSchema() as never
    const expr = (s as { $defs: { expr: { oneOf: unknown[] } } }).$defs.expr
    expect(expr.oneOf.length).toBe(Object.keys(OP_SCHEMA).length)
    expect((s as { properties: { schemaVersion: { const: number } } }).properties.schemaVersion.const).toBe(RULE_SCHEMA_VERSION)
  })
})
