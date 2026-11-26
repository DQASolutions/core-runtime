import { describe, it, expect } from 'vitest'
import type { Instance, FunctionIO } from '@dqa-ai-solutions/ontology-sdk'
import {
  num, text, rel, filter, sum, count, min, max, avg,
  eq, ne, lt, ge, and, or, not, any, all, exists, isEmpty,
  ifElse, lookup, reach, daysBetween, startsWith,
} from './core-ops.js'

// Minimal Instance factory + an in-memory FunctionIO over an adjacency map —
// enough to exercise the graph-navigating ops (rel/reach) deterministically.
const node = (id: string, data: Record<string, unknown> = {}): Instance =>
  ({ id, entityType: 'X', data, provenance: { source_ref: '', confirmed_by: '', confirmed_at: '' }, source_ref: '', confirmed_by: '', confirmed_at: '' })

function ioOver(nodes: Instance[], edges: Record<string, string[]>): FunctionIO {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  return {
    get: async (id) => byId.get(id) ?? null,
    find: async (_t) => nodes,
    neighbors: async (id, _rel) => (edges[id] ?? []).map((x) => byId.get(x)!).filter(Boolean),
  } as FunctionIO
}

describe('core-ops — access + arithmetic', () => {
  it('num/text coerce with defaults', () => {
    const n = node('a', { x: '12', y: 'hi' })
    expect(num(n, 'x')).toBe(12)
    expect(num(n, 'missing')).toBe(0)
    expect(text(n, 'y')).toBe('hi')
    expect(text(n, 'missing')).toBe('')
  })

  it('compare ops honour tolerance', () => {
    expect(eq(100, 100.5, 1)).toBe(true)   // within tolerance ⇒ equal
    expect(ne(100, 100.5, 1)).toBe(false)
    expect(ne(100, 102, 1)).toBe(true)     // beyond tolerance ⇒ not equal
    expect(lt(1, 2)).toBe(true)
    expect(ge(2, 2)).toBe(true)
  })

  it('boolean logic', () => {
    expect(and(true, true, false)).toBe(false)
    expect(or(false, false, true)).toBe(true)
    expect(not(false)).toBe(true)
  })
})

describe('core-ops — set algebra (σ/π/γ) and quantifiers', () => {
  const set = [node('a', { v: 10, side: 'debit' }), node('b', { v: 20, side: 'credit' }), node('c', { v: 30, side: 'debit' })]

  it('sum over a field, and over a projection fn', async () => {
    expect(await sum(set, 'v')).toBe(60)
    expect(await sum(set, (n) => num(n, 'v') * 2)).toBe(120)
  })

  it('filter (σ) then sum (γ) — the per-side selection pattern', async () => {
    const debits = await filter(set, (n) => text(n, 'side') === 'debit')
    expect(debits.map((n) => n.id)).toEqual(['a', 'c'])
    expect(await sum(debits, 'v')).toBe(40)
  })

  it('count / min / max / avg', async () => {
    expect(await count(set)).toBe(3)
    expect(await count(set, (n) => num(n, 'v') > 15)).toBe(2)
    expect(await min(set, 'v')).toBe(10)
    expect(await max(set, 'v')).toBe(30)
    expect(await avg(set, 'v')).toBe(20)
    expect(await min([], 'v')).toBeUndefined()
  })

  it('quantifiers any/all and existence', async () => {
    expect(await any(set, (n) => num(n, 'v') > 25)).toBe(true)
    expect(await all(set, (n) => num(n, 'v') > 5)).toBe(true)
    expect(await all(set, (n) => num(n, 'v') > 15)).toBe(false)
    expect(exists(set)).toBe(true)
    expect(isEmpty([])).toBe(true)
  })

  it('ifElse and lookup', async () => {
    expect(ifElse(true, 'a', 'b')).toBe('a')
    expect((await lookup(set, 'side', 'credit'))?.id).toBe('b')
    expect(await lookup(set, 'side', 'none')).toBeNull()
  })
})

describe('core-ops — graph navigation + boundary primitives', () => {
  const nodes = [node('1'), node('2'), node('3'), node('4')]
  const io = ioOver(nodes, { '1': ['2'], '2': ['3'], '3': ['4'] }) // a chain 1→2→3→4

  it('rel returns immediate neighbours', async () => {
    const ns = await rel(io, nodes[0], 'r')
    expect(ns.map((n) => n.id)).toEqual(['2'])
  })

  it('reach computes transitive closure (FO+TC), terminating on cycles', async () => {
    const reached = await reach(io, nodes[0], 'r')
    expect(reached.map((n) => n.id).sort()).toEqual(['2', '3', '4'])

    const cyclic = ioOver([node('a'), node('b')], { a: ['b'], b: ['a'] })
    const r2 = await reach(cyclic, node('a'), 'r') // must terminate on the cycle, not loop forever
    expect(r2.map((n) => n.id)).toEqual(['b']) // reachable others; the start node is excluded
  })

  it('daysBetween / startsWith', () => {
    expect(daysBetween('2026-01-01', '2026-01-31')).toBe(30)
    expect(daysBetween('2026-02-01', '2026-01-01')).toBe(-31)
    expect(startsWith('5111', '511')).toBe(true)
    expect(startsWith('131', '511')).toBe(false)
  })
})
