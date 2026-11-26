import { describe, it, expect } from 'vitest'
import type { Instance, FunctionIO } from '@dqa-ai-solutions/ontology-sdk'
import { validateOntologyStructure, scoreOntologyData, reconciliationRules, type OntologyForSoundness, type OntologyData } from './validate-ontology.js'

const onto: OntologyForSoundness = {
  entities: [{ name: 'Order' }, { name: 'LineItem' }, { name: 'Confirmation' }],
  relationships: [
    { name: 'order_lineItem', from: 'Order', to: 'LineItem', kind: 'derivation', fold: 'sum', whole: 'total', parts: 'amount' },
    { name: 'order_confirmation', from: 'Order', to: 'Confirmation', kind: 'correspondence', match: { left: 'total', right: 'confirmed' } },
    { name: 'order_self', from: 'Order', to: 'Order', kind: 'derivation', fold: 'sum', whole: 'total', parts: 'total' }, // hierarchy (self-ref)
  ],
}

describe('validate-ontology — structural soundness', () => {
  it('classifies atomic vs aggregate and reach-to-leaf; self-ref = recursive not cycle', () => {
    const r = validateOntologyStructure(onto)
    expect(r.aggregate).toContain('Order')
    expect(r.atomic).toContain('LineItem')
    expect(r.reachToLeaf['Order']).toBe(true)
    expect(r.recursive).toContain('order_self')   // hierarchy, NOT flagged as a bad cycle
    expect(r.cycles).toEqual([])
    expect(r.ok).toBe(true)
  })
  it('flags an unknown kind and a real type-cycle', () => {
    const bad: OntologyForSoundness = {
      entities: [{ name: 'A' }, { name: 'B' }],
      relationships: [
        { name: 'a_b', from: 'A', to: 'B', kind: 'composition' },
        { name: 'b_a', from: 'B', to: 'A', kind: 'derivation', fold: 'sum', whole: 'x', parts: 'x' },
        { name: 'weird', from: 'A', to: 'B', kind: 'frobnicate' as never },
      ],
    }
    const r = validateOntologyStructure(bad)
    expect(r.unknownKinds.some((s) => s.includes('frobnicate'))).toBe(true)
    expect(r.cycles.length).toBeGreaterThan(0) // A→B→A is a real bad cycle
  })
})

const N = (data: Record<string, unknown>): Instance => ({ id: 'i' + Math.round((data.total as number ?? data.amount as number) ?? 0) + Math.random().toString(36).slice(2, 5), entityType: 'X', data, provenance: { source_ref: '', confirmed_by: '', confirmed_at: '' }, source_ref: '', confirmed_by: '', confirmed_at: '' })

describe('validate-ontology — empirical reconciliation', () => {
  it('derivation reconciles whole = Σ parts; surfaces a mismatch', () => {
    const okNode = N({ total: 300 }), badNode = N({ total: 999 })
    const li = { [`${okNode.id}|order_lineItem`]: [N({ amount: 200 }), N({ amount: 100 })], [`${badNode.id}|order_lineItem`]: [N({ amount: 50 })] }
    const data: OntologyData = { instances: (t) => (t === 'Order' ? [okNode, badNode] : []), neighbors: (id, r) => li[`${id}|${r}`] ?? [] }
    const score = scoreOntologyData({ ...onto, relationships: [onto.relationships[0]] }, data)
    expect(score[0]).toMatchObject({ name: 'order_lineItem', checked: 2, ok: 1 }) // okO reconciles, badO doesn't
    expect(score[0].score).toBe(0.5)
  })
})

describe('validate-ontology — auto-generate reconciliation rules', () => {
  it('emits runnable rules from derivation + correspondence kinds', async () => {
    const rules = reconciliationRules(onto)
    const ids = rules.map((r) => r.id)
    expect(ids).toContain('R-RECON-order_lineItem-total')
    expect(ids).toContain('R-MATCH-order_confirmation')
    // the generated derivation rule actually runs and fires on a mismatch
    const r = rules.find((x) => x.id === 'R-RECON-order_lineItem-total')!
    const order = N({ total: 999 })
    const io = { get: async () => null, find: async () => [], neighbors: async () => [N({ amount: 100 })] } as unknown as FunctionIO
    expect(Boolean(await r.khi!(order, io))).toBe(true)  // 999 ≠ Σ(100) → fires
    const okOrder = N({ total: 100 })
    expect(Boolean(await r.khi!(okOrder, io))).toBe(false) // 100 = Σ(100) → no fire
  })

  it('takes the tolerance from the app — 1 suits whole currency units, not kilograms', async () => {
    const io = { get: async () => null, find: async () => [], neighbors: async () => [N({ amount: 2 })] } as unknown as FunctionIO
    const order = N({ total: 2.5 })
    const loose = reconciliationRules(onto).find((x) => x.id === 'R-RECON-order_lineItem-total')!
    const tight = reconciliationRules(onto, { tolerance: 0.01 }).find((x) => x.id === 'R-RECON-order_lineItem-total')!
    expect(Boolean(await loose.khi!(order, io))).toBe(false) // |2.5 − 2| ≤ 1
    expect(Boolean(await tight.khi!(order, io))).toBe(true)
  })

  it('SUMIF reconcile: filters parts by criterion ($self prop) — per-side, no false positive', async () => {
    const onto2 = {
      entities: [{ name: 'Acct' }, { name: 'Entry' }],
      relationships: [{
        name: 'acct_entry', from: 'Acct', to: 'Entry', kind: 'derivation' as const,
        reconcile: [{ whole: 'periodDebit', sum: 'amount', where: { debitAccount: '$code' } }],
      }],
    }
    const r = reconciliationRules(onto2).find((x) => x.id === 'R-RECON-acct_entry-periodDebit')!
    const acct = N({ code: '111', periodDebit: 100 })
    // entries: one DEBIT 111 (amount 100), one CREDIT 111 (amount 50) — only the debit side counts
    const io = { get: async () => null, find: async () => [], neighbors: async () => [N({ debitAccount: '111', amount: 100 }), N({ debitAccount: 'x', amount: 50 })] } as unknown as FunctionIO
    expect(Boolean(await r.khi!(acct, io))).toBe(false) // SUMIF(amount WHERE debitAccount=111) = 100 = periodDebit → no false positive
  })
})
