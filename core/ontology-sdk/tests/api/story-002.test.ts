/**
 * DQA:covers=S002-AC-001,S002-AC-002,S002-AC-005,S002-AC-006,S002-AC-007,S002-AC-009,S002-AC-010,S002-AC-011
 * DQA:rule=BR-004
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { createOntology, InMemoryAdapter, OntologyError } from '../../src/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOntology() {
  const adapter = new InMemoryAdapter()
  const ontology = createOntology({ adapter })
  return { ontology }
}

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

// Setup helper: register "invoice" and "document" entity types for a tenant
async function setupBaseEntities(
  ontology: ReturnType<typeof createOntology>,
  ctx: { tenantId: string },
): Promise<void> {
  await ontology.defineEntityType({ name: 'invoice', label: 'Invoice', properties: [] }, ctx)
  await ontology.defineEntityType({ name: 'document', label: 'Document', properties: [] }, ctx)
}

// ---------------------------------------------------------------------------
// BR-004: RelationshipType Endpoints Must Reference Known EntityTypes
// ---------------------------------------------------------------------------

describe('BDD STORY-002 / BR-004: happy — defineRelationshipType with known EntityTypes succeeds (AC-001, FR-N01, FR-N02, FR-N05)', () => {
  it('Happy — defines RelationshipType "proves" and it appears in getSchema() immediately (AC-001, FR-N01, FR-N05)', async () => {
    // Given the SDK is initialised for tenant "tenant-alpha"
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }

    // And EntityTypes "invoice" and "document" are already registered
    await setupBaseEntities(ontology, ctx)

    // When the consumer calls defineRelationshipType with valid def
    await ontology.defineRelationshipType(
      { name: 'proves', from: 'invoice', to: 'document', cardinality: 'N..1', directed: true },
      ctx,
    )

    // Then the call resolves without error
    const schema = await ontology.getSchema(ctx)

    // And (await ontology.getSchema()).relationshipTypes contains an entry with
    // name "proves", from "invoice", to "document", cardinality "N..1", directed true
    const rt = schema.relationshipTypes.find((r) => r.name === 'proves')
    expect(rt).toBeDefined()
    expect(rt!.name).toBe('proves')
    expect(rt!.from).toBe('invoice')
    expect(rt!.to).toBe('document')
    expect(rt!.cardinality).toBe('N..1')
    expect(rt!.directed).toBe(true)
  })

  it('Violation — unknown "to" EntityType is rejected with UNKNOWN_ENTITY_TYPE (AC-002, FR-E02)', async () => {
    // Given EntityType "invoice" is registered but EntityType "ghost" is not
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await ontology.defineEntityType({ name: 'invoice', label: 'Invoice', properties: [] }, ctx)

    // When the consumer calls defineRelationshipType with unknown "to"
    // Then the call rejects with error code "UNKNOWN_ENTITY_TYPE"
    await expectRejects(
      ontology.defineRelationshipType(
        { name: 'connects', from: 'invoice', to: 'ghost', cardinality: '1..N', directed: false },
        ctx,
      ),
      'UNKNOWN_ENTITY_TYPE',
    )

    // And the OntologySchema is not modified (no RelationshipType added)
    const schema = await ontology.getSchema(ctx)
    expect(schema.relationshipTypes).toHaveLength(0)
  })

  it('Edge — self-referencing RelationshipType (from === to) is valid (FR-N07, FR-X01)', async () => {
    // Given the SDK is initialised for tenant "tenant-alpha"
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await ontology.defineEntityType({ name: 'invoice', label: 'Invoice', properties: [] }, ctx)

    // When the consumer calls defineRelationshipType with from === to
    await ontology.defineRelationshipType(
      { name: 'references_self', from: 'invoice', to: 'invoice', cardinality: 'N..N', directed: true },
      ctx,
    )

    // Then the call resolves without error
    const schema = await ontology.getSchema(ctx)

    // And (await ontology.getSchema()).relationshipTypes contains entry with name "references_self"
    const rt = schema.relationshipTypes.find((r) => r.name === 'references_self')
    expect(rt).toBeDefined()
    expect(rt!.from).toBe('invoice')
    expect(rt!.to).toBe('invoice')
  })

  it('Recovery — after UNKNOWN_ENTITY_TYPE schema is unchanged (FR-E02, FR-E01)', async () => {
    // Given no RelationshipTypes exist in the registry
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupBaseEntities(ontology, ctx)

    // When the consumer calls defineRelationshipType with unknown "to"
    await expectRejects(
      ontology.defineRelationshipType(
        { name: 'bad_rel', from: 'invoice', to: 'nonexistent', cardinality: '1..1', directed: true },
        ctx,
      ),
      'UNKNOWN_ENTITY_TYPE',
    )

    // Then (await ontology.getSchema()).relationshipTypes is still empty
    const schema = await ontology.getSchema(ctx)
    expect(schema.relationshipTypes).toHaveLength(0)
  })

  it('Violation — unknown "from" EntityType is rejected with UNKNOWN_ENTITY_TYPE (FR-E01)', async () => {
    // Given EntityType "document" is registered but "ghost" is not
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await ontology.defineEntityType({ name: 'document', label: 'Document', properties: [] }, ctx)

    // When the consumer calls defineRelationshipType with unknown "from"
    await expectRejects(
      ontology.defineRelationshipType(
        { name: 'connects', from: 'ghost', to: 'document', cardinality: '1..N', directed: false },
        ctx,
      ),
      'UNKNOWN_ENTITY_TYPE',
    )

    // And schema unchanged
    const schema = await ontology.getSchema(ctx)
    expect(schema.relationshipTypes).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// BR-004: Cross-tenant isolation (NFR-S01)
// ---------------------------------------------------------------------------

describe('BDD STORY-002 / BR-004: cross-tenant isolation — "from" from a different tenant is rejected (FR-E01, NFR-S01)', () => {
  it('Violation — EntityType registered in tenant-beta but NOT tenant-gamma rejected with UNKNOWN_ENTITY_TYPE', async () => {
    // Given EntityType "invoice" is registered for tenant "tenant-beta" but NOT for tenant "tenant-gamma"
    const { ontology } = makeOntology()
    const ctxBeta = { tenantId: 'tenant-beta' }
    const ctxGamma = { tenantId: 'tenant-gamma' }

    await ontology.defineEntityType({ name: 'invoice', label: 'Invoice', properties: [] }, ctxBeta)

    // And EntityType "document" is registered for tenant "tenant-gamma"
    await ontology.defineEntityType({ name: 'document', label: 'Document', properties: [] }, ctxGamma)

    // When the consumer calls defineRelationshipType under tenant "tenant-gamma"
    // using "invoice" (which only exists in tenant-beta)
    await expectRejects(
      ontology.defineRelationshipType(
        { name: 'cross_rel', from: 'invoice', to: 'document', cardinality: '1..1', directed: true },
        ctxGamma,
      ),
      'UNKNOWN_ENTITY_TYPE',
    )

    // And no RelationshipType was added to tenant-gamma
    const schema = await ontology.getSchema(ctxGamma)
    expect(schema.relationshipTypes).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// BR-013: Backend Opacity — cardinality stored and surfaced as exact string token
// ---------------------------------------------------------------------------

describe('BDD STORY-002 / BR-013: each cardinality token stored and returned verbatim (FR-N03, FR-D03)', () => {
  it('Happy — cardinality "1..1" stored and returned verbatim (FR-N03, FR-D03)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await ontology.defineEntityType({ name: 'account', label: 'Account', properties: [] }, ctx)
    await ontology.defineEntityType({ name: 'item', label: 'Item', properties: [] }, ctx)

    await ontology.defineRelationshipType(
      { name: 'rel_one_one', from: 'account', to: 'item', cardinality: '1..1', directed: true },
      ctx,
    )

    const schema = await ontology.getSchema(ctx)
    const rt = schema.relationshipTypes.find((r) => r.name === 'rel_one_one')
    expect(rt!.cardinality).toBe('1..1')
  })

  it('Happy — cardinality "1..N" stored and returned verbatim (FR-N03, FR-D03)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await ontology.defineEntityType({ name: 'account', label: 'Account', properties: [] }, ctx)
    await ontology.defineEntityType({ name: 'item', label: 'Item', properties: [] }, ctx)

    await ontology.defineRelationshipType(
      { name: 'rel_one_many', from: 'account', to: 'item', cardinality: '1..N', directed: true },
      ctx,
    )

    const schema = await ontology.getSchema(ctx)
    const rt = schema.relationshipTypes.find((r) => r.name === 'rel_one_many')
    expect(rt!.cardinality).toBe('1..N')
  })

  it('Happy — cardinality "N..1" stored and returned verbatim (FR-N03, FR-D03)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await ontology.defineEntityType({ name: 'account', label: 'Account', properties: [] }, ctx)
    await ontology.defineEntityType({ name: 'item', label: 'Item', properties: [] }, ctx)

    await ontology.defineRelationshipType(
      { name: 'rel_many_one', from: 'account', to: 'item', cardinality: 'N..1', directed: true },
      ctx,
    )

    const schema = await ontology.getSchema(ctx)
    const rt = schema.relationshipTypes.find((r) => r.name === 'rel_many_one')
    expect(rt!.cardinality).toBe('N..1')
  })

  it('Happy — cardinality "N..N" stored and returned verbatim (FR-N03, FR-D03)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await ontology.defineEntityType({ name: 'account', label: 'Account', properties: [] }, ctx)
    await ontology.defineEntityType({ name: 'item', label: 'Item', properties: [] }, ctx)

    await ontology.defineRelationshipType(
      { name: 'rel_many_many', from: 'account', to: 'item', cardinality: 'N..N', directed: true },
      ctx,
    )

    const schema = await ontology.getSchema(ctx)
    const rt = schema.relationshipTypes.find((r) => r.name === 'rel_many_many')
    expect(rt!.cardinality).toBe('N..N')
  })

  it('Violation — cardinality "many-to-many" (non-canonical) is rejected with TYPE_MISMATCH (FR-E05, FR-N03)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupBaseEntities(ontology, ctx)

    await expectRejects(
      ontology.defineRelationshipType(
        { name: 'bad_cardinality', from: 'invoice', to: 'document', cardinality: 'many-to-many' as never, directed: false },
        ctx,
      ),
      'TYPE_MISMATCH',
    )
  })

  it('Edge — directed: false with cardinality 1..1 is a valid combination (FR-X02, FR-N04, FR-D04)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupBaseEntities(ontology, ctx)

    await ontology.defineRelationshipType(
      { name: 'undirected_one_one', from: 'invoice', to: 'document', cardinality: '1..1', directed: false },
      ctx,
    )

    const schema = await ontology.getSchema(ctx)
    const rt = schema.relationshipTypes.find((r) => r.name === 'undirected_one_one')
    expect(rt!.directed).toBe(false)
    expect(typeof rt!.directed).toBe('boolean')
  })

  it('Recovery — after TYPE_MISMATCH on cardinality the schema is unchanged (FR-E05, FR-D03)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupBaseEntities(ontology, ctx)

    // Confirm schema starts empty
    const schemaBefore = await ontology.getSchema(ctx)
    expect(schemaBefore.relationshipTypes).toHaveLength(0)

    await expectRejects(
      ontology.defineRelationshipType(
        { name: 'bad_card_rel', from: 'invoice', to: 'document', cardinality: 'n:n' as never, directed: true },
        ctx,
      ),
      'TYPE_MISMATCH',
    )

    const schemaAfter = await ontology.getSchema(ctx)
    expect(schemaAfter.relationshipTypes).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Domain Event: RelationshipTypeDefined (observable via getSchema state)
// ---------------------------------------------------------------------------

describe('BDD STORY-002 / RelationshipTypeDefined event checks via public API', () => {
  it('Event missing — no RelationshipTypeDefined when required field "name" is absent (FR-E04, FR-N01)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupBaseEntities(ontology, ctx)

    // When defineRelationshipType is called with no "name" field
    await expectRejects(
      ontology.defineRelationshipType(
        { name: '' as never, from: 'invoice', to: 'document', cardinality: '1..1', directed: true },
        ctx,
      ),
      'REQUIRED_PROPERTY_MISSING',
    )

    // And no RelationshipTypeDefined event emitted (schema unchanged)
    const schema = await ontology.getSchema(ctx)
    expect(schema.relationshipTypes).toHaveLength(0)
  })

  it('Event idempotency — duplicate defineRelationshipType emits exactly one event; second call rejected (FR-N10, FR-E03)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupBaseEntities(ontology, ctx)

    // Call 1: succeeds — RelationshipTypeDefined event emitted once
    await ontology.defineRelationshipType(
      { name: 'proves', from: 'invoice', to: 'document', cardinality: 'N..1', directed: true },
      ctx,
    )

    // Schema now has exactly one entry
    const schemaAfterFirst = await ontology.getSchema(ctx)
    expect(schemaAfterFirst.relationshipTypes.filter((r) => r.name === 'proves')).toHaveLength(1)

    // Call 2: same name → UNKNOWN_RELATIONSHIP_TYPE — no second event emitted
    await expectRejects(
      ontology.defineRelationshipType(
        { name: 'proves', from: 'invoice', to: 'document', cardinality: 'N..1', directed: true },
        ctx,
      ),
      'UNKNOWN_RELATIONSHIP_TYPE',
    )

    // Total RelationshipTypeDefined events for "proves" is 1
    const schemaAfterSecond = await ontology.getSchema(ctx)
    expect(schemaAfterSecond.relationshipTypes.filter((r) => r.name === 'proves')).toHaveLength(1)
    expect(schemaAfterSecond.relationshipTypes).toHaveLength(1)
  })

  it('Event concurrency — two concurrent defineRelationshipType("proves") calls resolve deterministically (FR-N10, FR-E03, NFR-P01)', async () => {
    // Given no RelationshipType "proves" exists
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupBaseEntities(ontology, ctx)

    // When defineRelationshipType is called concurrently from two contexts
    const [result1, result2] = await Promise.allSettled([
      ontology.defineRelationshipType(
        { name: 'proves', from: 'invoice', to: 'document', cardinality: 'N..1', directed: true },
        ctx,
      ),
      ontology.defineRelationshipType(
        { name: 'proves', from: 'invoice', to: 'document', cardinality: 'N..1', directed: true },
        ctx,
      ),
    ])

    // Then exactly one call resolves without error
    const resolved = [result1, result2].filter((r) => r.status === 'fulfilled')
    const rejected = [result1, result2].filter((r) => r.status === 'rejected')
    expect(resolved).toHaveLength(1)
    expect(rejected).toHaveLength(1)

    // And the rejected one has error code UNKNOWN_RELATIONSHIP_TYPE
    const rejectedResult = rejected[0] as PromiseRejectedResult
    expect(rejectedResult.reason).toBeInstanceOf(OntologyError)
    expect((rejectedResult.reason as OntologyError).code).toBe('UNKNOWN_RELATIONSHIP_TYPE')

    // And (await ontology.getSchema()).relationshipTypes contains exactly one entry named "proves"
    const schema = await ontology.getSchema(ctx)
    expect(schema.relationshipTypes.filter((r) => r.name === 'proves')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// FR-N06: optional description
// ---------------------------------------------------------------------------

describe('BDD STORY-002 / FR-N06: optional description stored verbatim via public API', () => {
  it('description present is stored and returned verbatim (FR-N06, FR-D01, FR-D02)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupBaseEntities(ontology, ctx)

    const desc = 'Invoice proves a document exists'
    await ontology.defineRelationshipType(
      { name: 'proves', from: 'invoice', to: 'document', cardinality: 'N..1', directed: true, description: desc },
      ctx,
    )

    const schema = await ontology.getSchema(ctx)
    const rt = schema.relationshipTypes.find((r) => r.name === 'proves')
    expect(rt!.description).toBe(desc)
  })

  it('description absent when not provided (FR-N06)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupBaseEntities(ontology, ctx)

    await ontology.defineRelationshipType(
      { name: 'proves', from: 'invoice', to: 'document', cardinality: 'N..1', directed: true },
      ctx,
    )

    const schema = await ontology.getSchema(ctx)
    const rt = schema.relationshipTypes.find((r) => r.name === 'proves')
    expect(rt!.description).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// FR-N08: multiple RelationshipTypes with same from or to
// FR-X03: same shape, different name — both accepted
// ---------------------------------------------------------------------------

describe('BDD STORY-002 / FR-N08 + FR-X03: multiple relationship types per entity via public API', () => {
  it('FR-N08: multiple RelationshipTypes from the same EntityType are all accepted', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupBaseEntities(ontology, ctx)

    await ontology.defineRelationshipType(
      { name: 'proves', from: 'invoice', to: 'document', cardinality: 'N..1', directed: true },
      ctx,
    )
    await ontology.defineRelationshipType(
      { name: 'references', from: 'invoice', to: 'document', cardinality: '1..N', directed: false },
      ctx,
    )
    await ontology.defineRelationshipType(
      { name: 'links_to', from: 'invoice', to: 'document', cardinality: 'N..N', directed: true },
      ctx,
    )

    const schema = await ontology.getSchema(ctx)
    expect(schema.relationshipTypes).toHaveLength(3)
  })

  it('FR-X03: two RelationshipTypes with identical from/to/cardinality but different names are both accepted', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupBaseEntities(ontology, ctx)

    await ontology.defineRelationshipType(
      { name: 'proves', from: 'invoice', to: 'document', cardinality: 'N..1', directed: true },
      ctx,
    )
    await ontology.defineRelationshipType(
      { name: 'supports', from: 'invoice', to: 'document', cardinality: 'N..1', directed: true },
      ctx,
    )

    const schema = await ontology.getSchema(ctx)
    expect(schema.relationshipTypes).toHaveLength(2)
    expect(schema.relationshipTypes.map((r) => r.name)).toEqual(['proves', 'supports'])
  })
})

// ---------------------------------------------------------------------------
// FR-E04: REQUIRED_PROPERTY_MISSING for empty name, from, to
// ---------------------------------------------------------------------------

describe('BDD STORY-002 / FR-E04: required fields validation via public API', () => {
  let ontology: ReturnType<typeof createOntology>
  let ctx: { tenantId: string }

  beforeEach(async () => {
    const result = makeOntology()
    ontology = result.ontology
    ctx = { tenantId: 'tenant-alpha' }
    await setupBaseEntities(ontology, ctx)
  })

  it('FR-E04: empty name → REQUIRED_PROPERTY_MISSING, schema unchanged', async () => {
    await expectRejects(
      ontology.defineRelationshipType(
        { name: '' as never, from: 'invoice', to: 'document', cardinality: 'N..1', directed: true },
        ctx,
      ),
      'REQUIRED_PROPERTY_MISSING',
    )
    const schema = await ontology.getSchema(ctx)
    expect(schema.relationshipTypes).toHaveLength(0)
  })

  it('FR-E04: empty from → REQUIRED_PROPERTY_MISSING, schema unchanged', async () => {
    await expectRejects(
      ontology.defineRelationshipType(
        { name: 'proves', from: '' as never, to: 'document', cardinality: 'N..1', directed: true },
        ctx,
      ),
      'REQUIRED_PROPERTY_MISSING',
    )
    const schema = await ontology.getSchema(ctx)
    expect(schema.relationshipTypes).toHaveLength(0)
  })

  it('FR-E04: empty to → REQUIRED_PROPERTY_MISSING, schema unchanged', async () => {
    await expectRejects(
      ontology.defineRelationshipType(
        { name: 'proves', from: 'invoice', to: '' as never, cardinality: 'N..1', directed: true },
        ctx,
      ),
      'REQUIRED_PROPERTY_MISSING',
    )
    const schema = await ontology.getSchema(ctx)
    expect(schema.relationshipTypes).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// FR-D04: directed stored as native boolean (not 0/1 or string)
// ---------------------------------------------------------------------------

describe('BDD STORY-002 / FR-D04: directed is stored as native boolean via public API', () => {
  it('directed: true is a native boolean true (FR-D04)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupBaseEntities(ontology, ctx)

    await ontology.defineRelationshipType(
      { name: 'proves', from: 'invoice', to: 'document', cardinality: 'N..1', directed: true },
      ctx,
    )

    const schema = await ontology.getSchema(ctx)
    const rt = schema.relationshipTypes.find((r) => r.name === 'proves')!
    expect(rt.directed).toBe(true)
    expect(typeof rt.directed).toBe('boolean')
  })

  it('directed: false is a native boolean false (FR-D04)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupBaseEntities(ontology, ctx)

    await ontology.defineRelationshipType(
      { name: 'links', from: 'invoice', to: 'document', cardinality: '1..1', directed: false },
      ctx,
    )

    const schema = await ontology.getSchema(ctx)
    const rt = schema.relationshipTypes.find((r) => r.name === 'links')!
    expect(rt.directed).toBe(false)
    expect(typeof rt.directed).toBe('boolean')
  })
})

// ---------------------------------------------------------------------------
// NFR-P01: performance — defineRelationshipType within 50ms p99 on InMemoryAdapter
// ---------------------------------------------------------------------------

describe('BDD STORY-002 / NFR-P01: performance budget via public API', () => {
  it('defineRelationshipType resolves within 50ms p99 on InMemoryAdapter (NFR-P01)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'perf-tenant' }
    await ontology.defineEntityType({ name: 'a', label: 'A', properties: [] }, ctx)
    await ontology.defineEntityType({ name: 'b', label: 'B', properties: [] }, ctx)

    const start = Date.now()
    await ontology.defineRelationshipType(
      { name: 'perf_rel', from: 'a', to: 'b', cardinality: '1..N', directed: true },
      ctx,
    )
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(50)
  })
})
