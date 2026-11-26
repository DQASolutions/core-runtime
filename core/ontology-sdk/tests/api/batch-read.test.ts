/**
 * K1 — the batch read door.
 *
 * neighbors() used to resolve its id set with a per-id getInstance loop, so a
 * list screen walking one relationship per row issued N+1 reads; on a backend
 * that opens a transaction per read that is N+1 transactions. These tests pin
 * three things: the batch door is USED when present, the fallback is CORRECT
 * when absent, and neighborsOf() answers the question a list actually asks.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createOntology, InMemoryAdapter, type Ontology } from '../../src/index.js'
import type { Edge, Instance } from '../../src/types/index.js'
import type { MultiEdgeQuery, StorageAdapter } from '../../src/ports/storage-adapter.js'

const ctx = { tenantId: 't1' }
const prov = { source_ref: 'src', confirmed_by: 'u', confirmed_at: '2026-01-01T00:00:00.000Z' }

/** Counts every read the API makes, and can hide the batch doors on demand. */
class CountingAdapter {
  singleInstance = 0
  batchInstance = 0
  singleEdge = 0
  batchEdge = 0

  constructor(private readonly inner: StorageAdapter, private readonly batch: boolean) {}

  static wrap(inner: StorageAdapter, batch: boolean): StorageAdapter & CountingAdapter {
    const self = new CountingAdapter(inner, batch)
    const proxy = new Proxy(inner as unknown as Record<string, unknown>, {
      get(target, prop, receiver) {
        if (prop === 'getInstance') {
          return (id: string) => { self.singleInstance += 1; return inner.getInstance(id) }
        }
        if (prop === 'getInstances') {
          if (!batch) return undefined
          return (ids: readonly string[]) => {
            self.batchInstance += 1
            return inner.getInstances?.(ids) ?? Promise.resolve([] as Instance[])
          }
        }
        if (prop === 'queryEdges') {
          return (spec: Parameters<StorageAdapter['queryEdges']>[0]) => {
            self.singleEdge += 1
            return inner.queryEdges(spec)
          }
        }
        if (prop === 'queryEdgesMulti') {
          if (!batch) return undefined
          return (spec: MultiEdgeQuery) => {
            self.batchEdge += 1
            return inner.queryEdgesMulti?.(spec) ?? Promise.resolve([] as Edge[])
          }
        }
        if (prop === 'withTenant') return () => proxy
        if (prop === '__counter') return self
        return Reflect.get(target, prop, receiver)
      },
    })
    return proxy as unknown as StorageAdapter & CountingAdapter
  }
}

const counterOf = (a: StorageAdapter): CountingAdapter =>
  (a as unknown as { __counter: CountingAdapter }).__counter

/** One owner with `n` parts hanging off it, plus a second owner for isolation. */
async function seed(ont: Ontology, n: number) {
  await ont.defineEntityType({ name: 'owner', label: 'Owner', properties: [] }, ctx)
  await ont.defineEntityType(
    { name: 'part', label: 'Part', properties: [{ name: 'i', type: 'number' }] },
    ctx,
  )
  await ont.defineRelationshipType(
    { name: 'has', from: 'owner', to: 'part', cardinality: 'N..N', directed: true },
    ctx,
  )
  const a = await ont.create('owner', {}, prov, ctx)
  const b = await ont.create('owner', {}, prov, ctx)
  for (let i = 0; i < n; i += 1) {
    const p = await ont.create('part', { i }, prov, ctx)
    await ont.link('has', a.id, p.id, prov, ctx)
  }
  const lone = await ont.create('part', { i: -1 }, prov, ctx)
  await ont.link('has', b.id, lone.id, prov, ctx)
  return { a: a.id, b: b.id }
}

describe('K1 · neighbors() uses the batch instance door', () => {
  let adapter: StorageAdapter
  let ont: Ontology
  let ids: { a: string; b: string }

  beforeEach(async () => {
    adapter = CountingAdapter.wrap(new InMemoryAdapter(), true)
    ont = createOntology({ adapter })
    ids = await seed(ont, 5)
    const c = counterOf(adapter)
    c.singleInstance = 0; c.batchInstance = 0; c.singleEdge = 0; c.batchEdge = 0
  })

  it('reads all neighbours in ONE call, not one per neighbour', async () => {
    const got = await ont.neighbors(ids.a, 'has', ctx)
    expect(got).toHaveLength(5)
    const c = counterOf(adapter)
    expect(c.batchInstance).toBe(1)
    expect(c.singleInstance).toBe(0)
  })
})

describe('K1 · fallback when the adapter has no batch door', () => {
  it('returns the same neighbours via the per-id loop', async () => {
    const withBatch = CountingAdapter.wrap(new InMemoryAdapter(), true)
    const without = CountingAdapter.wrap(new InMemoryAdapter(), false)

    const fast = createOntology({ adapter: withBatch })
    const slow = createOntology({ adapter: without })
    const fastIds = await seed(fast, 4)
    const slowIds = await seed(slow, 4)

    const a = (await fast.neighbors(fastIds.a, 'has', ctx)).map((i) => i.data['i'])
    const b = (await slow.neighbors(slowIds.a, 'has', ctx)).map((i) => i.data['i'])
    expect(a.sort()).toEqual(b.sort())
    // and the loop really was taken
    expect(counterOf(without).singleInstance).toBeGreaterThan(0)
    expect(counterOf(without).batchInstance).toBe(0)
  })
})

describe('K1 · neighborsOf — a page of rows at once', () => {
  let adapter: StorageAdapter
  let ont: Ontology
  let ids: { a: string; b: string }

  beforeEach(async () => {
    adapter = CountingAdapter.wrap(new InMemoryAdapter(), true)
    ont = createOntology({ adapter })
    ids = await seed(ont, 3)
    const c = counterOf(adapter)
    c.singleInstance = 0; c.batchInstance = 0; c.singleEdge = 0; c.batchEdge = 0
  })

  it('answers for every start id with ONE edge read and ONE instance read', async () => {
    const got = await ont.neighborsOf([ids.a, ids.b], 'has', ctx)
    expect(got.get(ids.a)).toHaveLength(3)
    expect(got.get(ids.b)).toHaveLength(1)
    const c = counterOf(adapter)
    expect(c.batchEdge).toBe(1)
    expect(c.batchInstance).toBe(1)
    expect(c.singleEdge).toBe(0)
    expect(c.singleInstance).toBe(0)
  })

  it('maps a start with no neighbours to an empty array, not to absent', async () => {
    const lonely = await ont.create('owner', {}, prov, ctx)
    const got = await ont.neighborsOf([lonely.id], 'has', ctx)
    expect(got.has(lonely.id)).toBe(true)
    expect(got.get(lonely.id)).toEqual([])
  })

  it('agrees with neighbors() called one id at a time', async () => {
    const batch = await ont.neighborsOf([ids.a, ids.b], 'has', ctx)
    for (const id of [ids.a, ids.b]) {
      const one = await ont.neighbors(id, 'has', ctx)
      expect((batch.get(id) ?? []).map((i) => i.id).sort())
        .toEqual(one.map((i) => i.id).sort())
    }
  })

  it('de-duplicates repeated start ids', async () => {
    const got = await ont.neighborsOf([ids.a, ids.a, ids.a], 'has', ctx)
    expect(got.size).toBe(1)
    expect(got.get(ids.a)).toHaveLength(3)
  })

  it('returns an empty map for an empty id list, without touching storage', async () => {
    const got = await ont.neighborsOf([], 'has', ctx)
    expect(got.size).toBe(0)
    const c = counterOf(adapter)
    expect(c.batchEdge + c.singleEdge + c.batchInstance + c.singleInstance).toBe(0)
  })
})

describe('K1 · direction is respected in the batch form', () => {
  const ctx2 = { tenantId: 't2' }

  it('an undirected relationship is followed from both endpoints', async () => {
    const ont = createOntology({ adapter: new InMemoryAdapter() })
    await ont.defineEntityType({ name: 'node', label: 'Node', properties: [{ name: 'n', type: 'text' }] }, ctx2)
    await ont.defineRelationshipType(
      { name: 'near', from: 'node', to: 'node', cardinality: 'N..N', directed: false },
      ctx2,
    )
    const x = await ont.create('node', { n: 'x' }, prov, ctx2)
    const y = await ont.create('node', { n: 'y' }, prov, ctx2)
    await ont.link('near', x.id, y.id, prov, ctx2)

    const got = await ont.neighborsOf([x.id, y.id], 'near', ctx2)
    expect((got.get(x.id) ?? []).map((i) => i.data['n'])).toEqual(['y'])
    expect((got.get(y.id) ?? []).map((i) => i.data['n'])).toEqual(['x'])
  })

  it('a directed relationship is followed forward only', async () => {
    const ont = createOntology({ adapter: new InMemoryAdapter() })
    await ont.defineEntityType({ name: 'node', label: 'Node', properties: [{ name: 'n', type: 'text' }] }, ctx2)
    await ont.defineRelationshipType(
      { name: 'points', from: 'node', to: 'node', cardinality: 'N..N', directed: true },
      ctx2,
    )
    const x = await ont.create('node', { n: 'x' }, prov, ctx2)
    const y = await ont.create('node', { n: 'y' }, prov, ctx2)
    await ont.link('points', x.id, y.id, prov, ctx2)

    const got = await ont.neighborsOf([x.id, y.id], 'points', ctx2)
    expect((got.get(x.id) ?? []).map((i) => i.data['n'])).toEqual(['y'])
    expect(got.get(y.id)).toEqual([])
  })
})
