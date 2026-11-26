/**
 * AGGREGATE rule kind (E1.4): group instances → sum/count a field → flag every
 * instance in a group whose aggregate crosses a threshold.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createOntology, InMemoryAdapter, type Ontology, type RuleDef } from '../../src/index.js'

const ctx = { tenantId: 't1' }
const prov = { source_ref: 'src', confirmed_by: 'u', confirmed_at: '2026-01-01T00:00:00.000Z' }

let ont: Ontology

const ruleBase = {
  name: 'agg', appliesTo: 'payment', severity: 'CANH_BAO',
  message: 'Payment {id} part of a flagged group.',
  source_ref: 'rule:seed', confirmed_by: 'u', confirmed_at: '2026-01-01T00:00:00.000Z',
  enabled: true, version: 1,
}

beforeEach(async () => {
  ont = createOntology({ adapter: new InMemoryAdapter() })
  await ont.defineEntityType(
    { name: 'payment', label: 'Payment', properties: [
      { name: 'supplier', type: 'text' }, { name: 'day', type: 'text' }, { name: 'amount', type: 'number' },
    ] },
    ctx,
  )
})

async function pay(supplier: string, day: string, amount: number) {
  return ont.create('payment', { supplier, day, amount }, prov, ctx)
}

describe('AGGREGATE rule — sum per group ≥ threshold', () => {
  beforeEach(async () => {
    await ont.registerRule(
      {
        ...ruleBase, id: 'R-CASH', kind: 'AGGREGATE',
        condition: { op: 'aggregate', groupBy: ['supplier', 'day'], fn: 'sum', field: 'amount', cmp: '>=', threshold: 20_000_000 },
      } as RuleDef,
      ctx,
    )
  })

  it('flags every instance in a group that crosses the threshold, and none below', async () => {
    const a1 = await pay('ACME', 'D1', 15_000_000)
    const a2 = await pay('ACME', 'D1', 8_000_000) // ACME/D1 sum = 23m ≥ 20m → both flagged
    await pay('BETA', 'D1', 5_000_000) // BETA/D1 = 5m → not flagged
    await pay('ACME', 'D2', 9_000_000) // ACME/D2 = 9m → not flagged (different day group)

    const results = await ont.evaluateRules({ tenantId: 't1', entityType: 'payment' })
    const flaggedTargets = results.map((r) => r.target).sort()
    expect(flaggedTargets).toEqual([a1.id, a2.id].sort())
    expect(results.every((r) => r.fired)).toBe(true)
  })

  it('does not flag when no group crosses the threshold', async () => {
    await pay('ACME', 'D1', 10_000_000)
    await pay('BETA', 'D1', 9_000_000)
    const results = await ont.evaluateRules({ tenantId: 't1', entityType: 'payment' })
    expect(results).toHaveLength(0)
  })
})

describe('AGGREGATE rule — count per group', () => {
  it('counts instances per group and flags groups at/above the threshold', async () => {
    await ont.registerRule(
      {
        ...ruleBase, id: 'R-COUNT', kind: 'AGGREGATE',
        condition: { op: 'aggregate', groupBy: ['supplier'], fn: 'count', cmp: '>=', threshold: 3 },
      } as RuleDef,
      ctx,
    )
    await pay('ACME', 'D1', 1); await pay('ACME', 'D2', 1); await pay('ACME', 'D3', 1) // 3 → flagged
    await pay('BETA', 'D1', 1) // 1 → not

    const flags = await ont.evaluateFlags({ tenantId: 't1', entityType: 'payment' })
    expect(flags).toHaveLength(3) // the 3 ACME payments; BETA's single payment not flagged
    expect(flags.every((f) => f.ruleId === 'R-COUNT')).toBe(true)
  })

  it('rejects a malformed aggregate rule at registration', async () => {
    let caught: unknown
    try {
      await ont.registerRule(
        { ...ruleBase, id: 'R-BAD', kind: 'AGGREGATE', condition: { op: 'aggregate', groupBy: [], fn: 'sum', cmp: '>=', threshold: 1 } } as RuleDef,
        ctx,
      )
    } catch (e) { caught = e }
    expect(caught).toBeDefined()
  })
})

describe('AGGREGATE nested inside another condition', () => {
  // `aggregate` has no answer for one instance. Nested, it used to evaluate to
  // `undefined`, so `not(aggregate)` held for EVERY payment and flagged them all.
  it('does not flag every instance through not(aggregate)', async () => {
    await ont.registerRule(
      {
        ...ruleBase, id: 'R-NOT-AGG', kind: 'AGGREGATE',
        condition: { op: 'not', clause: { op: 'aggregate', groupBy: ['supplier'], fn: 'count', cmp: '>=', threshold: 3 } },
      } as RuleDef,
      ctx,
    )
    await pay('ACME', 'D1', 1); await pay('BETA', 'D1', 1)
    const flags = await ont.evaluateFlags({ tenantId: 't1', entityType: 'payment' })
    expect(flags.filter((f) => f.ruleId === 'R-NOT-AGG')).toHaveLength(0)
  })
})
