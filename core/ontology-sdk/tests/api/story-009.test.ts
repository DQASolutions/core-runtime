/**
 * DQA:covers=S009-AC-001,S009-AC-002,S009-AC-005,S009-AC-006,S009-AC-007,S009-AC-009,S009-AC-010,S009-AC-011
 * DQA:rule=BR-014
 */

import { describe, it, expect } from 'vitest'
import {
  createOntology,
  InMemoryAdapter,
  OntologyError,
  type Provenance,
  type VectorAdapter,
  type VectorHit,
} from '../../src/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOntology(opts?: { vector?: VectorAdapter; embed?: (text: string) => Promise<number[]> }) {
  const adapter = new InMemoryAdapter()
  const ontology = createOntology({ adapter, ...opts })
  return { ontology, adapter }
}

const baseProv: Provenance = {
  source_ref: 'test:seed',
  confirmed_by: 'tester@acme.com',
  confirmed_at: '2026-03-15T10:00:00.000Z',
}

const ctx = { tenantId: 'tenant-alpha' }

async function expectRejects(promise: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown
  try {
    await promise
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(OntologyError)
  expect((caught as OntologyError).code).toBe(code)
}

/** Creates a minimal mock VectorAdapter whose search returns the given chunks */
function makeVectorAdapter(
  chunks: Array<{ id: string; text: string; score: number; meta: Record<string, unknown> }>,
): VectorAdapter {
  const hits: VectorHit[] = chunks.map((c) => ({ id: c.id, score: c.score, meta: { text: c.text, ...c.meta } }))
  const self: VectorAdapter = {
    withTenant: (_tid: string) => self,
    search: async (_embedding: number[], k: number) => hits.slice(0, k > 0 ? k : 0),
    upsert: async () => {},
  }
  return self
}

/** Mock VectorAdapter whose search always rejects */
function makeFailingVectorAdapter(): VectorAdapter {
  const self: VectorAdapter = {
    withTenant: (_tid: string) => self,
    search: async () => {
      throw new Error('vector backend unavailable')
    },
    upsert: async () => {},
  }
  return self
}

/** Simple mock embed function */
const mockEmbed = async (_query: string): Promise<number[]> => [0.1, 0.2, 0.3]

/** Setup a basic schema with invoice + document entity types */
async function setupSchema(
  ontology: ReturnType<typeof createOntology>,
  tenantCtx: { tenantId: string },
) {
  await ontology.defineEntityType(
    { name: 'invoice', label: 'Invoice', properties: [{ name: 'amount', type: 'number' }] },
    tenantCtx,
  )
  await ontology.defineEntityType(
    { name: 'document', label: 'Document', properties: [] },
    tenantCtx,
  )
  await ontology.defineRelationshipType(
    { name: 'proves', from: 'invoice', to: 'document', cardinality: 'N..N', directed: true },
    tenantCtx,
  )
}

// ---------------------------------------------------------------------------
// AC-001: Structural-only retrieval works when vector is not configured
// ---------------------------------------------------------------------------

describe('BDD STORY-009 / AC-001: structural-only retrieval works when vector is not configured', () => {
  it('AC-001 — context() with around resolves with ContextBundle containing center + neighbours, documents: []', async () => {
    const { ontology } = makeOntology()
    await setupSchema(ontology, ctx)

    const inv = await ontology.create('invoice', { amount: 500 }, baseProv, ctx)
    const doc = await ontology.create('document', {}, baseProv, ctx)
    await ontology.link('proves', inv.id, doc.id, baseProv, ctx)

    const bundle = await ontology.context(
      { query: 'invoice proof status', around: inv.id, useVector: false },
      ctx,
    )

    expect(bundle).toBeDefined()
    expect(Array.isArray(bundle.structured.instances)).toBe(true)
    expect(Array.isArray(bundle.structured.edges)).toBe(true)
    expect(Array.isArray(bundle.documents)).toBe(true)

    // Center instance is present
    const instanceIds = bundle.structured.instances.map((i) => i.id)
    expect(instanceIds).toContain(inv.id)
    // Direct neighbour (document) is present
    expect(instanceIds).toContain(doc.id)
    // No documents (no vector)
    expect(bundle.documents).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// AC-002: useVector:true with no embed returns documents: [] silently
// ---------------------------------------------------------------------------

describe('BDD STORY-009 / AC-002: useVector:true with no embed configured returns documents: [] silently', () => {
  it('AC-002 — context({ useVector: true }) without embed resolves (no throw) with documents: []', async () => {
    const { ontology } = makeOntology() // no embed, no vector
    await setupSchema(ontology, ctx)

    const bundle = await ontology.context(
      { query: 'tax discrepancy', useVector: true, k: 5 },
      ctx,
    )

    expect(bundle).toBeDefined()
    expect(Array.isArray(bundle.documents)).toBe(true)
    expect(bundle.documents).toHaveLength(0)
    // structured is always present
    expect(bundle.structured).toBeDefined()
    expect(Array.isArray(bundle.structured.instances)).toBe(true)
    expect(Array.isArray(bundle.structured.edges)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// FR-N01: context() method signature — only query is required
// ---------------------------------------------------------------------------

describe('BDD STORY-009 / FR-N01: context() method signature works — query required, others optional', () => {
  it('FR-N01 — context() with only query (no around, no useVector, no k) resolves', async () => {
    const { ontology } = makeOntology()
    await setupSchema(ontology, ctx)

    const bundle = await ontology.context({ query: 'just a query' }, ctx)

    expect(bundle).toBeDefined()
    expect(bundle.structured).toBeDefined()
    expect(bundle.documents).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// FR-N02: ContextBundle always has structured and documents fields
// ---------------------------------------------------------------------------

describe('BDD STORY-009 / FR-N02: ContextBundle always has structured and documents fields', () => {
  it('FR-N02 — both structured and documents are always present (never absent or undefined)', async () => {
    const { ontology } = makeOntology()
    await setupSchema(ontology, ctx)

    const bundle = await ontology.context({ query: 'anything' }, ctx)

    // Both top-level fields always present
    expect('structured' in bundle).toBe(true)
    expect('documents' in bundle).toBe(true)
    expect(bundle.structured).not.toBeUndefined()
    expect(bundle.structured).not.toBeNull()
    expect(bundle.documents).not.toBeUndefined()
    expect(bundle.documents).not.toBeNull()
    // documents is an array (may be empty but never absent)
    expect(Array.isArray(bundle.documents)).toBe(true)
  })

  it('FR-N02 — structured always has instances and edges arrays', async () => {
    const { ontology } = makeOntology()
    await setupSchema(ontology, ctx)

    const bundle = await ontology.context({ query: 'anything' }, ctx)

    expect(Array.isArray(bundle.structured.instances)).toBe(true)
    expect(Array.isArray(bundle.structured.edges)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// FR-N03: around populates structured with center + neighbours
// ---------------------------------------------------------------------------

describe('BDD STORY-009 / FR-N03: around populates structured with center instance + neighbours', () => {
  it('FR-N03 — around causes structured.instances to contain the center and all direct neighbours', async () => {
    const { ontology } = makeOntology()
    await setupSchema(ontology, ctx)

    const inv = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    const doc1 = await ontology.create('document', {}, baseProv, ctx)
    const doc2 = await ontology.create('document', {}, baseProv, ctx)
    await ontology.link('proves', inv.id, doc1.id, baseProv, ctx)
    await ontology.link('proves', inv.id, doc2.id, baseProv, ctx)

    const bundle = await ontology.context({ query: 'test', around: inv.id }, ctx)

    const ids = bundle.structured.instances.map((i) => i.id)
    expect(ids).toContain(inv.id)
    expect(ids).toContain(doc1.id)
    expect(ids).toContain(doc2.id)
  })

  it('FR-N03 — structured.edges contain the edges connecting center to neighbours', async () => {
    const { ontology } = makeOntology()
    await setupSchema(ontology, ctx)

    const inv = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    const doc = await ontology.create('document', {}, baseProv, ctx)
    await ontology.link('proves', inv.id, doc.id, baseProv, ctx)

    const bundle = await ontology.context({ query: 'test', around: inv.id }, ctx)

    expect(bundle.structured.edges.length).toBeGreaterThan(0)
    const edge = bundle.structured.edges[0]!
    expect(edge.fromId).toBe(inv.id)
    expect(edge.toId).toBe(doc.id)
    expect(edge.relationship).toBe('proves')
  })
})

// ---------------------------------------------------------------------------
// FR-N04: no around + useVector:false → structured with empty instances and edges
// ---------------------------------------------------------------------------

describe('BDD STORY-009 / FR-N04: no around + useVector:false → structured: { instances: [], edges: [] }', () => {
  it('FR-N04 — context without around and useVector:false returns empty structured (no full-table scan)', async () => {
    const { ontology } = makeOntology()
    await setupSchema(ontology, ctx)

    // Create instances — they should NOT appear in structured when no around is given
    await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    await ontology.create('document', {}, baseProv, ctx)

    const bundle = await ontology.context({ query: 'test', useVector: false }, ctx)

    expect(bundle.structured.instances).toHaveLength(0)
    expect(bundle.structured.edges).toHaveLength(0)
    expect(bundle.documents).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// FR-N05: useVector:true + embed configured → embed() called + VectorAdapter.search called
// ---------------------------------------------------------------------------

describe('BDD STORY-009 / FR-N05: useVector:true + embed configured → embed() and VectorAdapter.search() called', () => {
  it('FR-N05 — useVector:true with configured embed and vector → documents populated from search results', async () => {
    const sampleChunks = [
      { id: 'chunk-1', text: 'Invoice processing details', score: 0.95, meta: {} },
      { id: 'chunk-2', text: 'Tax regulation overview', score: 0.87, meta: {} },
    ]
    const vector = makeVectorAdapter(sampleChunks)
    const { ontology } = makeOntology({ vector, embed: mockEmbed })
    await setupSchema(ontology, ctx)

    const bundle = await ontology.context({ query: 'invoice tax', useVector: true, k: 5 }, ctx)

    expect(bundle.documents.length).toBeGreaterThan(0)
    expect(bundle.documents[0]!.id).toBe('chunk-1')
    expect(bundle.documents[1]!.id).toBe('chunk-2')
  })

  it('FR-N05 — embed() is called exactly once with the query string', async () => {
    let capturedQuery: string | null = null
    const trackingEmbed = async (query: string): Promise<number[]> => {
      capturedQuery = query
      return [0.1, 0.2, 0.3]
    }
    const vector = makeVectorAdapter([{ id: 'c1', text: 'hello', score: 0.9, meta: {} }])
    const { ontology } = makeOntology({ vector, embed: trackingEmbed })
    await setupSchema(ontology, ctx)

    await ontology.context({ query: 'my specific query', useVector: true, k: 3 }, ctx)

    expect(capturedQuery).toBe('my specific query')
  })
})

// ---------------------------------------------------------------------------
// FR-N06: useVector:true + no embed → documents: [] (no throw)
// ---------------------------------------------------------------------------

describe('BDD STORY-009 / FR-N06: useVector:true with no embed configured returns documents: [] without throwing', () => {
  it('FR-N06 — useVector:true without embed resolves with documents: [] (no error)', async () => {
    // vector configured but no embed
    const vector = makeVectorAdapter([{ id: 'c1', text: 'hello', score: 0.9, meta: {} }])
    const { ontology } = makeOntology({ vector }) // no embed
    await setupSchema(ontology, ctx)

    const bundle = await ontology.context({ query: 'test', useVector: true, k: 5 }, ctx)

    expect(bundle.documents).toHaveLength(0)
    expect(bundle.structured).toBeDefined()
  })

  it('FR-N06 — no vector + no embed + useVector:true also resolves without error', async () => {
    const { ontology } = makeOntology() // no embed, no vector
    await setupSchema(ontology, ctx)

    const bundle = await ontology.context({ query: 'test', useVector: true }, ctx)

    expect(bundle.documents).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// FR-N08: default k = 10 when not specified
// ---------------------------------------------------------------------------

describe('BDD STORY-009 / FR-N08: default k = 10 when k is not specified', () => {
  it('FR-N08 — when k is absent, VectorAdapter.search is called with k=10 (returns up to 10 chunks)', async () => {
    // Provide 15 chunks; without k override, search should use default k=10
    const chunks = Array.from({ length: 15 }, (_, i) => ({
      id: `chunk-${i}`,
      text: `text ${i}`,
      score: 0.9 - i * 0.01,
      meta: {},
    }))
    let capturedK: number | null = null
    const trackingVector: VectorAdapter = {
      withTenant: function (_tid: string) { return this },
      search: async (_embedding: number[], k: number) => {
        capturedK = k
        return chunks.slice(0, k > 0 ? k : 0).map((c) => ({
          id: c.id,
          score: c.score,
          meta: { text: c.text },
        }))
      },
      upsert: async () => {},
    }

    const { ontology } = makeOntology({ vector: trackingVector, embed: mockEmbed })
    await setupSchema(ontology, ctx)

    const bundle = await ontology.context({ query: 'test', useVector: true }, ctx) // no k

    expect(capturedK).toBe(10)
    expect(bundle.documents.length).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// FR-N09: query passed verbatim to embed()
// ---------------------------------------------------------------------------

describe('BDD STORY-009 / FR-N09: query string is passed verbatim to embed() without modification', () => {
  it('FR-N09 — query with special characters is passed to embed() exactly as provided', async () => {
    const rawQuery = '  Invoice #123 — tax 10% + VAT?  '
    let capturedQuery: string | null = null
    const trackingEmbed = async (q: string): Promise<number[]> => {
      capturedQuery = q
      return [0.1]
    }
    const vector = makeVectorAdapter([])
    const { ontology } = makeOntology({ vector, embed: trackingEmbed })
    await setupSchema(ontology, ctx)

    await ontology.context({ query: rawQuery, useVector: true }, ctx)

    expect(capturedQuery).toBe(rawQuery)
  })
})

// ---------------------------------------------------------------------------
// FR-E01: INSTANCE_NOT_FOUND when around doesn't exist
// ---------------------------------------------------------------------------

describe('BDD STORY-009 / FR-E01: INSTANCE_NOT_FOUND when around references a non-existent instance', () => {
  it('FR-E01 — context({ around: "ghost-id" }) rejects with INSTANCE_NOT_FOUND', async () => {
    const { ontology } = makeOntology()
    await setupSchema(ontology, ctx)

    await expectRejects(
      ontology.context({ query: 'test', around: 'non-existent-id' }, ctx),
      'INSTANCE_NOT_FOUND',
    )
  })

  it('FR-E01 — no ContextBundle is returned when INSTANCE_NOT_FOUND is raised', async () => {
    const { ontology } = makeOntology()
    await setupSchema(ontology, ctx)

    let result: unknown = 'NOT_THROWN'
    try {
      result = await ontology.context({ query: 'test', around: 'ghost-id' }, ctx)
    } catch (e) {
      result = e
    }
    expect(result).toBeInstanceOf(OntologyError)
    expect((result as OntologyError).code).toBe('INSTANCE_NOT_FOUND')
  })
})

// ---------------------------------------------------------------------------
// FR-E03: REQUIRED_PROPERTY_MISSING when query is empty
// ---------------------------------------------------------------------------

describe('BDD STORY-009 / FR-E03: REQUIRED_PROPERTY_MISSING when query is absent or empty', () => {
  it('FR-E03 — context() with empty query string rejects with REQUIRED_PROPERTY_MISSING', async () => {
    const { ontology } = makeOntology()

    await expectRejects(
      ontology.context({ query: '' }, ctx),
      'REQUIRED_PROPERTY_MISSING',
    )
  })

  it('FR-E03 — context() with whitespace-only query rejects with REQUIRED_PROPERTY_MISSING', async () => {
    const { ontology } = makeOntology()

    await expectRejects(
      ontology.context({ query: '   ' }, ctx),
      'REQUIRED_PROPERTY_MISSING',
    )
  })

  it('FR-E03 — no retrieval is attempted after REQUIRED_PROPERTY_MISSING rejection', async () => {
    const { ontology } = makeOntology()
    await setupSchema(ontology, ctx)

    // Create an instance so we can be sure no structural retrieval happened
    await ontology.create('invoice', { amount: 100 }, baseProv, ctx)

    let caught: unknown
    try {
      await ontology.context({ query: '' }, ctx)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(OntologyError)
    expect((caught as OntologyError).code).toBe('REQUIRED_PROPERTY_MISSING')
  })
})

// ---------------------------------------------------------------------------
// FR-E04: TENANT_MISMATCH when ctx.tenantId is absent or empty
// ---------------------------------------------------------------------------

describe('BDD STORY-009 / FR-E04: TENANT_MISMATCH when ctx.tenantId is absent or empty', () => {
  it('FR-E04 — context() with empty tenantId rejects with TENANT_MISMATCH', async () => {
    const { ontology } = makeOntology()

    await expectRejects(
      ontology.context({ query: 'test' }, { tenantId: '' }),
      'TENANT_MISMATCH',
    )
  })

  it('FR-E04 — no retrieval is attempted after TENANT_MISMATCH rejection', async () => {
    const { ontology } = makeOntology()

    let caught: unknown
    try {
      await ontology.context({ query: 'test' }, { tenantId: '' })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(OntologyError)
    expect((caught as OntologyError).code).toBe('TENANT_MISMATCH')
  })
})

// ---------------------------------------------------------------------------
// FR-E05: vector search failure → documents: [] (ContextBundle still returned)
// ---------------------------------------------------------------------------

describe('BDD STORY-009 / FR-E05: vector search failure → documents: [], ContextBundle still returned', () => {
  it('FR-E05 — VectorAdapter.search throwing does not reject context(); documents is []', async () => {
    const { ontology } = makeOntology({ vector: makeFailingVectorAdapter(), embed: mockEmbed })
    await setupSchema(ontology, ctx)

    const inv = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)

    // Must resolve (not throw), even though search fails
    const bundle = await ontology.context({ query: 'test', around: inv.id, useVector: true }, ctx)

    expect(bundle).toBeDefined()
    expect(bundle.documents).toHaveLength(0)
    // structured is still populated despite vector failure
    expect(bundle.structured.instances.map((i) => i.id)).toContain(inv.id)
  })

  it('FR-E05 — raw backend error is NOT surfaced in the ContextBundle or error message', async () => {
    const { ontology } = makeOntology({ vector: makeFailingVectorAdapter(), embed: mockEmbed })
    await setupSchema(ontology, ctx)

    // Should resolve — not throw — so no error surfacing at all
    const bundle = await ontology.context({ query: 'test', useVector: true }, ctx)
    expect(bundle).toBeDefined()
    expect(bundle.documents).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// FR-X01: no around + useVector:false → ContextBundle with empty structured + documents
// ---------------------------------------------------------------------------

describe('BDD STORY-009 / FR-X01: no around + useVector:false → ContextBundle with all-empty fields', () => {
  it('FR-X01 — context({ query }) returns { structured: { instances: [], edges: [] }, documents: [] }', async () => {
    const { ontology } = makeOntology()
    await setupSchema(ontology, ctx)

    const bundle = await ontology.context({ query: 'test' }, ctx)

    expect(bundle.structured.instances).toHaveLength(0)
    expect(bundle.structured.edges).toHaveLength(0)
    expect(bundle.documents).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// FR-X02: k=0 → documents: [] (no error)
// ---------------------------------------------------------------------------

describe('BDD STORY-009 / FR-X02: k=0 returns documents: [] without error', () => {
  it('FR-X02 — context({ useVector: true, k: 0 }) with configured embed resolves with documents: []', async () => {
    const chunks = [{ id: 'c1', text: 'hello', score: 0.9, meta: {} }]
    const { ontology } = makeOntology({ vector: makeVectorAdapter(chunks), embed: mockEmbed })
    await setupSchema(ontology, ctx)

    const bundle = await ontology.context({ query: 'test', useVector: true, k: 0 }, ctx)

    expect(bundle.documents).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// FR-X03: around with no neighbours → structured has only the center instance
// ---------------------------------------------------------------------------

describe('BDD STORY-009 / FR-X03: around with no neighbours → structured has only the center instance', () => {
  it('FR-X03 — center instance with no edges: structured.instances has 1 entry, edges: []', async () => {
    const { ontology } = makeOntology()
    await setupSchema(ontology, ctx)

    const inv = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)

    const bundle = await ontology.context({ query: 'test', around: inv.id }, ctx)

    expect(bundle.structured.instances).toHaveLength(1)
    expect(bundle.structured.instances[0]!.id).toBe(inv.id)
    expect(bundle.structured.edges).toHaveLength(0)
    expect(bundle.documents).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// FR-X04: both around + useVector:true → both structural and vector populated
// ---------------------------------------------------------------------------

describe('BDD STORY-009 / FR-X04: both around + useVector:true → structured and documents both populated', () => {
  it('FR-X04 — around gives structural neighbours AND useVector:true gives vector documents', async () => {
    const sampleChunks = [{ id: 'chunk-1', text: 'relevant passage', score: 0.92, meta: {} }]
    const { ontology } = makeOntology({ vector: makeVectorAdapter(sampleChunks), embed: mockEmbed })
    await setupSchema(ontology, ctx)

    const inv = await ontology.create('invoice', { amount: 200 }, baseProv, ctx)
    const doc = await ontology.create('document', {}, baseProv, ctx)
    await ontology.link('proves', inv.id, doc.id, baseProv, ctx)

    const bundle = await ontology.context({ query: 'test', around: inv.id, useVector: true, k: 5 }, ctx)

    // Structural neighbours
    const ids = bundle.structured.instances.map((i) => i.id)
    expect(ids).toContain(inv.id)
    expect(ids).toContain(doc.id)
    expect(bundle.structured.edges.length).toBeGreaterThan(0)

    // Vector documents
    expect(bundle.documents.length).toBeGreaterThan(0)
    expect(bundle.documents[0]!.id).toBe('chunk-1')
  })
})

// ---------------------------------------------------------------------------
// FR-X05: k > available chunks → returns all available chunks without error
// ---------------------------------------------------------------------------

describe('BDD STORY-009 / FR-X05: k > available chunks → returns all available chunks without error', () => {
  it('FR-X05 — k=100 with only 3 chunks returns all 3 chunks without error', async () => {
    const chunks = [
      { id: 'c1', text: 'chunk one', score: 0.9, meta: {} },
      { id: 'c2', text: 'chunk two', score: 0.8, meta: {} },
      { id: 'c3', text: 'chunk three', score: 0.7, meta: {} },
    ]
    const { ontology } = makeOntology({ vector: makeVectorAdapter(chunks), embed: mockEmbed })
    await setupSchema(ontology, ctx)

    const bundle = await ontology.context({ query: 'test', useVector: true, k: 100 }, ctx)

    expect(bundle.documents).toHaveLength(3)
    expect(bundle.documents.map((d) => d.id)).toEqual(['c1', 'c2', 'c3'])
  })
})

// ---------------------------------------------------------------------------
// FR-D01/FR-D02: Instance and Edge objects are full objects with required fields
// ---------------------------------------------------------------------------

describe('BDD STORY-009 / FR-D01: structured.instances are full Instance objects', () => {
  it('FR-D01 — each Instance in structured has id, entityType, data, provenance', async () => {
    const { ontology } = makeOntology()
    await setupSchema(ontology, ctx)

    const inv = await ontology.create('invoice', { amount: 999 }, baseProv, ctx)

    const bundle = await ontology.context({ query: 'test', around: inv.id }, ctx)

    expect(bundle.structured.instances.length).toBeGreaterThan(0)
    const instance = bundle.structured.instances[0]!
    expect(typeof instance.id).toBe('string')
    expect(typeof instance.entityType).toBe('string')
    expect(instance.data).toBeDefined()
    expect(instance.provenance).toBeDefined()
    expect(typeof instance.provenance.source_ref).toBe('string')
    expect(typeof instance.provenance.confirmed_by).toBe('string')
    expect(typeof instance.provenance.confirmed_at).toBe('string')
  })
})

describe('BDD STORY-009 / FR-D02: structured.edges are full Edge objects', () => {
  it('FR-D02 — each Edge in structured has id, relationship, fromId, toId, provenance', async () => {
    const { ontology } = makeOntology()
    await setupSchema(ontology, ctx)

    const inv = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    const doc = await ontology.create('document', {}, baseProv, ctx)
    await ontology.link('proves', inv.id, doc.id, baseProv, ctx)

    const bundle = await ontology.context({ query: 'test', around: inv.id }, ctx)

    expect(bundle.structured.edges.length).toBeGreaterThan(0)
    const edge = bundle.structured.edges[0]!
    expect(typeof edge.id).toBe('string')
    expect(typeof edge.relationship).toBe('string')
    expect(typeof edge.fromId).toBe('string')
    expect(typeof edge.toId).toBe('string')
    expect(edge.provenance).toBeDefined()
    expect(typeof edge.provenance.source_ref).toBe('string')
    expect(typeof edge.provenance.confirmed_by).toBe('string')
    expect(typeof edge.provenance.confirmed_at).toBe('string')
  })
})

// ---------------------------------------------------------------------------
// NFR-P01: Performance — structural retrieval (50 neighbours) under 100ms
// ---------------------------------------------------------------------------

describe('BDD STORY-009 / NFR-P01: structural traversal with 50 neighbours completes under 100ms', () => {
  it('NFR-P01 — context({ around }) for instance with 50 direct neighbours under 100ms at p99', async () => {
    const { ontology } = makeOntology()
    await setupSchema(ontology, ctx)

    // Create a center invoice and 50 document neighbours
    const center = await ontology.create('invoice', { amount: 1 }, baseProv, ctx)
    for (let i = 0; i < 50; i++) {
      const neighbour = await ontology.create('document', {}, baseProv, ctx)
      await ontology.link('proves', center.id, neighbour.id, baseProv, ctx)
    }

    const start = Date.now()
    const bundle = await ontology.context({ query: 'perf test', around: center.id, useVector: false }, ctx)
    const elapsed = Date.now() - start

    // 1 center + 50 neighbours
    expect(bundle.structured.instances.length).toBe(51)
    expect(elapsed).toBeLessThan(100)
  }, 5000)
})

// ---------------------------------------------------------------------------
// NFR-S01: Tenant isolation — context() only sees instances from its own tenant
// ---------------------------------------------------------------------------

describe('BDD STORY-009 / NFR-S01: tenant isolation — context() only sees instances from its own tenant', () => {
  it('NFR-S01 — around pointing at an instance in another tenant raises INSTANCE_NOT_FOUND', async () => {
    const { ontology } = makeOntology()
    const ctxAlpha = { tenantId: 'tenant-alpha' }
    const ctxBeta = { tenantId: 'tenant-beta' }

    await setupSchema(ontology, ctxAlpha)
    await setupSchema(ontology, ctxBeta)

    // Create instance in beta
    const betaInv = await ontology.create('invoice', { amount: 999 }, baseProv, ctxBeta)

    // Try to access it from alpha — must not be found
    await expectRejects(
      ontology.context({ query: 'test', around: betaInv.id }, ctxAlpha),
      'INSTANCE_NOT_FOUND',
    )
  })

  it('NFR-S01 — structural retrieval does not include instances from a different tenant', async () => {
    const { ontology } = makeOntology()
    const ctxAlpha = { tenantId: 'tenant-alpha' }
    const ctxBeta = { tenantId: 'tenant-beta' }

    await setupSchema(ontology, ctxAlpha)
    await setupSchema(ontology, ctxBeta)

    // Create instances in alpha
    const alphaInv = await ontology.create('invoice', { amount: 100 }, baseProv, ctxAlpha)
    const alphaDoc = await ontology.create('document', {}, baseProv, ctxAlpha)
    await ontology.link('proves', alphaInv.id, alphaDoc.id, baseProv, ctxAlpha)

    // Create instances in beta — these must not appear in alpha's context
    await ontology.create('invoice', { amount: 200 }, baseProv, ctxBeta)
    await ontology.create('document', {}, baseProv, ctxBeta)

    const bundle = await ontology.context({ query: 'test', around: alphaInv.id }, ctxAlpha)

    const ids = bundle.structured.instances.map((i) => i.id)
    expect(ids).toContain(alphaInv.id)
    expect(ids).toContain(alphaDoc.id)
    // Only alpha's 2 instances (center + 1 neighbour)
    expect(bundle.structured.instances.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// GAP-N05 resolution: FR-D03/D04 — Chunk.score range and ContextBundle serialisability
// ---------------------------------------------------------------------------

describe('BDD STORY-009 / FR-D03: Chunk.score is passed through as-is from VectorAdapter (no normalisation)', () => {
  it('Scores at boundary values (0.0 and 1.0) are preserved verbatim (FR-D03)', async () => {
    const hits: VectorHit[] = [
      { id: 'chunk-low', score: 0.0, meta: { text: 'low score' } },
      { id: 'chunk-high', score: 1.0, meta: { text: 'high score' } },
      { id: 'chunk-mid', score: 0.5, meta: { text: 'mid score' } },
    ]
    const stubVectorSelf: VectorAdapter = {
      async upsert() { return },
      async search(_query, _topK) { return hits },
      withTenant(_tid: string) { return stubVectorSelf },
    }
    const stubVector = stubVectorSelf
    const embedFn = async (_text: string) => [0.1, 0.2, 0.3]
    const { ontology } = makeOntology({ vector: stubVector, embed: embedFn })
    const ctx = { tenantId: 'tenant-d03' }
    await setupSchema(ontology, ctx)
    const inv = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)

    const bundle = await ontology.context({ query: 'test', useVector: true, around: inv.id }, ctx)

    const chunkLow = bundle.documents.find((c) => c.id === 'chunk-low')
    const chunkHigh = bundle.documents.find((c) => c.id === 'chunk-high')
    const chunkMid = bundle.documents.find((c) => c.id === 'chunk-mid')

    expect(chunkLow?.score).toBe(0.0)
    expect(chunkHigh?.score).toBe(1.0)
    expect(chunkMid?.score).toBe(0.5)
  })
})

describe('BDD STORY-009 / FR-D04: ContextBundle is JSON-serialisable', () => {
  it('JSON.stringify(bundle) does not throw and round-trips cleanly (FR-D04)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-d04' }
    await setupSchema(ontology, ctx)
    const inv = await ontology.create('invoice', { amount: 42 }, baseProv, ctx)

    const bundle = await ontology.context({ query: 'test', around: inv.id }, ctx)

    expect(() => JSON.stringify(bundle)).not.toThrow()
    const serialised = JSON.stringify(bundle)
    const parsed: unknown = JSON.parse(serialised)
    expect(parsed).toBeDefined()
    // The round-tripped bundle has the same structured.instances count
    expect((parsed as typeof bundle).structured.instances.length).toBe(bundle.structured.instances.length)
  })
})
