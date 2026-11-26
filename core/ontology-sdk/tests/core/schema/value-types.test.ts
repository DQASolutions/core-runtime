/**
 * Value types — one definition of "VND amount", pointed at by name. Exception
 * cases first: every way a declaration can look right and constrain nothing.
 */
import { describe, it, expect } from 'vitest'
import {
  resolveValueTypes, createOntology, InMemoryAdapter, OntologyError,
  type EntityTypeDef, type ValueTypeDef,
} from '../../../src/index.js'

const VT: ValueTypeDef[] = [
  { name: 'vnd', type: 'number', minimum: 0, maximum: 1_000_000_000_000, multipleOf: 1 },
  { name: 'shortName', type: 'text', maxLength: 200 },
  { name: 'civilDate', type: 'date', formatMinimum: '1900-01-01', formatMaximum: '2100-12-31' },
]
const ET: EntityTypeDef = {
  name: 'BudgetLine', label: 'Khoản',
  properties: [
    { name: 'amount', type: 'number', valueType: 'vnd' },
    { name: 'code', type: 'text', valueType: 'shortName', maxLength: 12 },
    { name: 'signedOn', type: 'date', valueType: 'civilDate' },
    { name: 'note', type: 'text' },
  ],
}
const ctx = { tenantId: 't-vt' }
const prov = { source_ref: 't', confirmed_by: 't', confirmed_at: '2026-09-12T00:00:00Z' }
const threw = (f: () => unknown) => { try { f(); return null } catch (e) { return e as OntologyError } }

describe('resolveValueTypes', () => {
  const [line] = resolveValueTypes([ET], VT)
  const p = (n: string) => line!.properties.find((x) => x.name === n)!

  it('merges the value type\'s constraints into the property', () => {
    expect(p('amount')).toMatchObject({ minimum: 0, maximum: 1e12, multipleOf: 1, valueTypeOf: 'vnd' })
    expect(p('signedOn')).toMatchObject({ formatMinimum: '1900-01-01', formatMaximum: '2100-12-31' })
  })
  it('the property may narrow — its own keyword wins', () => {
    expect(p('code').maxLength).toBe(12)
  })
  it('renames `valueType` to `valueTypeOf`, so the registry can tell resolved from forgotten', () => {
    expect('valueType' in p('amount')).toBe(false)
  })
  it('leaves properties without a value type untouched, and does not mutate its input', () => {
    expect(p('note')).toEqual({ name: 'note', type: 'text' })
    expect(ET.properties[0]).toEqual({ name: 'amount', type: 'number', valueType: 'vnd' })
  })

  it('the resolved constraints are ENFORCED on write', async () => {
    const o = createOntology({ adapter: new InMemoryAdapter() })
    await o.defineEntityType(line!, ctx)
    await expect(o.create('BudgetLine', { amount: 1500.5 }, prov, ctx)).rejects.toMatchObject({ code: 'CONSTRAINT_VIOLATED' })
    await expect(o.create('BudgetLine', { amount: -1 }, prov, ctx)).rejects.toMatchObject({ code: 'CONSTRAINT_VIOLATED' })
    await expect(o.create('BudgetLine', { signedOn: '1899-12-31' }, prov, ctx)).rejects.toMatchObject({ code: 'CONSTRAINT_VIOLATED' })
    await expect(o.create('BudgetLine', { amount: 1_500_000, signedOn: '2026-09-12' }, prov, ctx)).resolves.toBeTruthy()
  })
})

describe('refused — a value type that would constrain nothing, or the wrong thing', () => {
  const bad = (label: string, et: EntityTypeDef, vts: ValueTypeDef[] = VT) =>
    it(label, () => {
      const e = threw(() => resolveValueTypes([et], vts))
      expect(e).toBeInstanceOf(OntologyError)
      expect(e!.code).toBe('INVALID_CONSTRAINT')
    })
  const one = (p: EntityTypeDef['properties'][number]) => ({ name: 'X', label: 'X', properties: [p] })

  bad('an unknown value type', one({ name: 'a', type: 'number', valueType: 'vnđ' }))
  bad('a number value type on a text property', one({ name: 'a', type: 'text', valueType: 'vnd' }))
  bad('a value type declared twice', one({ name: 'a', type: 'number' }), [...VT, VT[0]!])
  bad('a value type that is itself meaningless', one({ name: 'a', type: 'number' }),
    [{ name: 'broken', type: 'number', maxLength: 5 } as ValueTypeDef])
  bad('a value type with minimum above maximum', one({ name: 'a', type: 'number' }),
    [{ name: 'inverted', type: 'number', minimum: 10, maximum: 1 }])

  it('⛔ defining a type whose `valueType` was never resolved is refused — not silently unconstrained', async () => {
    const o = createOntology({ adapter: new InMemoryAdapter() })
    await expect(o.defineEntityType(ET, ctx)).rejects.toMatchObject({ code: 'INVALID_CONSTRAINT' })
  })
})
