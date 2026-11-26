// QdrantVectorAdapter against a recording fake client — the adapter's own logic, no server:
// which client calls it makes (the Query API, which exists across the whole declared peer
// range — `search` was removed in client 1.20), how it maps hits, filters and tenants.
import { describe, it, expect } from 'vitest'
import type { QdrantClient } from '@qdrant/js-client-rest'
import { QdrantVectorAdapter } from '../../src/index.js'

function fakeClient(opts: { exists?: boolean; points?: Array<{ id: string | number; score: number; payload?: Record<string, unknown> }> } = {}) {
  const calls: Array<[string, ...unknown[]]> = []
  const collections = new Set<string>(opts.exists ? ['ont___default__'] : [])
  const client = {
    async collectionExists(name: string) { calls.push(['collectionExists', name]); return { exists: collections.has(name) } },
    async createCollection(name: string, body: unknown) { calls.push(['createCollection', name, body]); collections.add(name); return true },
    async upsert(name: string, body: unknown) { calls.push(['upsert', name, body]); return { status: 'completed' } },
    async query(name: string, body: unknown) { calls.push(['query', name, body]); return { points: opts.points ?? [] } },
    async search() { throw new Error('search() is gone in @qdrant/js-client-rest 1.20 — use query()') },
  }
  return { client: client as unknown as QdrantClient, calls }
}

describe('QdrantVectorAdapter', () => {
  it('searches with the Query API and maps points to hits', async () => {
    const { client, calls } = fakeClient({ exists: true, points: [{ id: 7, score: 0.9, payload: { text: 'a', kind: 'x' } }] })
    const hits = await new QdrantVectorAdapter({ client }).search([0.1, 0.2], 3)
    expect(hits).toEqual([{ id: '7', score: 0.9, meta: { text: 'a', kind: 'x' } }])
    const q = calls.find((c) => c[0] === 'query')
    expect(q).toEqual(['query', 'ont___default__', { query: [0.1, 0.2], limit: 3, with_payload: true }])
  })

  it('turns a row filter into must-match conditions, skipping non-primitive values', async () => {
    const { client, calls } = fakeClient({ exists: true })
    await new QdrantVectorAdapter({ client }).search([1], 5, { kind: 'x', n: 2, ok: true, nested: { a: 1 } })
    const body = calls.find((c) => c[0] === 'query')![2] as { filter: unknown }
    expect(body.filter).toEqual({ must: [
      { key: 'kind', match: { value: 'x' } },
      { key: 'n', match: { value: 2 } },
      { key: 'ok', match: { value: true } },
    ] })
  })

  it('returns no hits, without querying, when the collection does not exist yet', async () => {
    const { client, calls } = fakeClient({ exists: false })
    expect(await new QdrantVectorAdapter({ client }).search([1], 5)).toEqual([])
    expect(calls.some((c) => c[0] === 'query')).toBe(false)
  })

  it('creates the collection on first upsert, sized from the first embedding', async () => {
    const { client, calls } = fakeClient({ exists: false })
    await new QdrantVectorAdapter({ client }).upsert([{ id: 'p1', embedding: [1, 2, 3], text: 't', meta: { a: 1 } }])
    expect(calls.find((c) => c[0] === 'createCollection')).toEqual(['createCollection', 'ont___default__', { vectors: { size: 3, distance: 'Cosine' } }])
    expect(calls.find((c) => c[0] === 'upsert')).toEqual(['upsert', 'ont___default__', { points: [{ id: 'p1', vector: [1, 2, 3], payload: { text: 't', a: 1 } }] }])
  })

  it('keeps each tenant in its own collection', async () => {
    const { client, calls } = fakeClient({ exists: false })
    await new QdrantVectorAdapter({ client }).withTenant('acme corp').upsert([{ id: 'p', embedding: [1], text: 't', meta: {} }])
    expect(calls.find((c) => c[0] === 'upsert')![1]).toBe('ont_acme_corp')
  })
})
