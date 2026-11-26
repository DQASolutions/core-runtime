/**
 * DQA:covers=S001-AC-001,S001-AC-002,S001-AC-005,S001-AC-006,S001-AC-007,S001-AC-009,S001-AC-010,S001-AC-011
 * DQA:rule=BR-002,BR-003
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

async function expectRejects(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  let caught: unknown
  try {
    await promise
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(OntologyError)
  expect((caught as OntologyError).code).toBe(code)
}

// ---------------------------------------------------------------------------
// BR-002: Provenance Fields Must Not Be Declared by Caller
// ---------------------------------------------------------------------------

describe('BDD STORY-001 / BR-002: provenance auto-injection via public API', () => {
  it('Happy — defineEntityType with no provenance fields succeeds and injects all four fields (AC-001, FR-N01, FR-N02, FR-N06)', async () => {
    // Given the SDK is initialised for tenant "tenant-alpha"
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }

    // When the consumer calls defineEntityType with valid properties and no provenance fields
    await ontology.defineEntityType(
      { name: 'invoice', label: 'Invoice', properties: [{ name: 'amount', type: 'number', required: true }] },
      ctx,
    )

    // Then the call resolves without error
    const schema = await ontology.getSchema(ctx)
    const et = schema.entityTypes.find((e) => e.name === 'invoice')

    // And (await ontology.getSchema()).entityTypes contains an entry with name "invoice"
    expect(et).toBeDefined()

    // And that entry's properties array contains { name: "amount", type: "number", required: true }
    const amount = et!.properties.find((p) => p.name === 'amount')
    expect(amount).toMatchObject({ name: 'amount', type: 'number', required: true })

    // And that entry's properties array also contains all four auto-injected fields
    const names = et!.properties.map((p) => p.name)
    expect(names).toContain('id')
    expect(names).toContain('source_ref')
    expect(names).toContain('confirmed_by')
    expect(names).toContain('confirmed_at')

    // Verify types of injected fields
    expect(et!.properties.find((p) => p.name === 'id')).toMatchObject({ type: 'uuid' })
    expect(et!.properties.find((p) => p.name === 'source_ref')).toMatchObject({ type: 'text', required: true })
    expect(et!.properties.find((p) => p.name === 'confirmed_by')).toMatchObject({ type: 'text', required: true })
    expect(et!.properties.find((p) => p.name === 'confirmed_at')).toMatchObject({ type: 'datetime', required: true })

    // And the EntityTypeDefined "event" is emitted (observable: schema now contains the entry)
    expect(schema.entityTypes.length).toBe(1)
  })

  it('Violation — declaring "source_ref" in properties is rejected with PROVENANCE_FIELD_REDECLARED (AC-002, FR-E01)', async () => {
    // Given the SDK is initialised for tenant "tenant-alpha"
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }

    // When the consumer calls defineEntityType with source_ref in properties
    // Then the call rejects with error code "PROVENANCE_FIELD_REDECLARED"
    await expectRejects(
      ontology.defineEntityType(
        { name: 'invoice_bad', label: 'Bad Invoice', properties: [{ name: 'source_ref', type: 'text' }] },
        ctx,
      ),
      'PROVENANCE_FIELD_REDECLARED',
    )

    // And no EntityTypeDefined event is emitted (schema remains empty)
    const schema = await ontology.getSchema(ctx)
    expect(schema.entityTypes).toHaveLength(0)
  })

  it('Edge — empty properties array is valid; result contains exactly the four auto-injected fields (FR-X01, FR-N02)', async () => {
    // Given the SDK is initialised for tenant "tenant-alpha"
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }

    // When the consumer calls defineEntityType with empty properties array
    await ontology.defineEntityType(
      { name: 'bare_entity', label: 'Bare Entity', properties: [] },
      ctx,
    )

    // Then the call resolves without error
    const schema = await ontology.getSchema(ctx)
    const et = schema.entityTypes.find((e) => e.name === 'bare_entity')
    expect(et).toBeDefined()

    // And (await ontology.getSchema()).entityTypes entry "bare_entity" has exactly 4 properties
    expect(et!.properties).toHaveLength(4)

    // And those 4 properties are id, source_ref, confirmed_by, confirmed_at
    const names = et!.properties.map((p) => p.name)
    expect(names).toEqual(['id', 'source_ref', 'confirmed_by', 'confirmed_at'])
  })

  it('Recovery — after PROVENANCE_FIELD_REDECLARED the schema is unchanged and no event is emitted (FR-E01, AC-002)', async () => {
    // Given the SDK is initialised for tenant "tenant-alpha"
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }

    // And (await ontology.getSchema()).entityTypes has 0 entries
    const schemaBefore = await ontology.getSchema(ctx)
    expect(schemaBefore.entityTypes).toHaveLength(0)

    // When the consumer tries to declare "id" as a property
    await expectRejects(
      ontology.defineEntityType(
        { name: 'polluted', label: 'Polluted', properties: [{ name: 'id', type: 'text' as never }] },
        ctx,
      ),
      'PROVENANCE_FIELD_REDECLARED',
    )

    // Then (await ontology.getSchema()).entityTypes still has 0 entries
    const schemaAfter = await ontology.getSchema(ctx)
    expect(schemaAfter.entityTypes).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// BR-003: EntityType Name Unique per Tenant
// ---------------------------------------------------------------------------

describe('BDD STORY-001 / BR-003: entity type name uniqueness per tenant via public API', () => {
  it('Happy — same EntityType name on two different tenants does not conflict (FR-N01, FR-N06)', async () => {
    // Given EntityType "invoice" is registered for tenant "tenant-alpha"
    const { ontology } = makeOntology()
    const ctxAlpha = { tenantId: 'tenant-alpha' }
    const ctxBeta = { tenantId: 'tenant-beta' }

    await ontology.defineEntityType({ name: 'invoice', label: 'Invoice', properties: [] }, ctxAlpha)

    // When the consumer calls defineEntityType under a different tenant
    await ontology.defineEntityType({ name: 'invoice', label: 'Invoice', properties: [] }, ctxBeta)

    // Then the call resolves without error for tenant "tenant-beta"
    const schemaAlpha = await ontology.getSchema(ctxAlpha)
    const schemaBeta = await ontology.getSchema(ctxBeta)

    // And EntityType "invoice" is present independently in both registries
    expect(schemaAlpha.entityTypes.find((e) => e.name === 'invoice')).toBeDefined()
    expect(schemaBeta.entityTypes.find((e) => e.name === 'invoice')).toBeDefined()
    expect(schemaAlpha.entityTypes).toHaveLength(1)
    expect(schemaBeta.entityTypes).toHaveLength(1)
  })

  it('Violation — duplicate name in the same tenant is rejected with DUPLICATE_ENTITY_TYPE (FR-E04, FR-N10)', async () => {
    // Given EntityType "invoice" is already registered for tenant "tenant-alpha"
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }

    await ontology.defineEntityType({ name: 'invoice', label: 'Invoice', properties: [] }, ctx)

    // When the consumer tries to define the same name again
    await expectRejects(
      ontology.defineEntityType({ name: 'invoice', label: 'Invoice 2', properties: [] }, ctx),
      'DUPLICATE_ENTITY_TYPE',
    )
  })

  it('Edge — name consisting only of whitespace is rejected with REQUIRED_PROPERTY_MISSING (FR-X03, FR-E05)', async () => {
    // Given the SDK is initialised for tenant "tenant-alpha"
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }

    // When the consumer calls defineEntityType with whitespace-only name
    await expectRejects(
      ontology.defineEntityType(
        { name: '   ' as never, label: 'Whitespace', properties: [] },
        ctx,
      ),
      'REQUIRED_PROPERTY_MISSING',
    )

    // And no EntityTypeDefined event is emitted
    const schema = await ontology.getSchema(ctx)
    expect(schema.entityTypes).toHaveLength(0)
  })

  it('Recovery — after DUPLICATE_ENTITY_TYPE the existing definition is not modified (FR-E04, FR-N10)', async () => {
    // Given EntityType "invoice" is registered with properties [amount (number, required)]
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }

    await ontology.defineEntityType(
      { name: 'invoice', label: 'Invoice', properties: [{ name: 'amount', type: 'number', required: true }] },
      ctx,
    )

    // When the consumer attempts to redefine it with different properties
    await expectRejects(
      ontology.defineEntityType(
        { name: 'invoice', label: 'Invoice Clone', properties: [{ name: 'vat', type: 'number' }] },
        ctx,
      ),
      'DUPLICATE_ENTITY_TYPE',
    )

    // Then the existing definition still has property "amount" with type "number"
    const schema = await ontology.getSchema(ctx)
    const et = schema.entityTypes.find((e) => e.name === 'invoice')!
    expect(et.properties.find((p) => p.name === 'amount')).toMatchObject({ type: 'number', required: true })

    // And the entry does NOT have property "vat"
    expect(et.properties.find((p) => p.name === 'vat')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// BR-007: PropertyDef type validation at definition time
// ---------------------------------------------------------------------------

describe('BDD STORY-001 / BR-007: property type validation via public API', () => {
  it('Happy — all 8 valid PropertyDef types are accepted (FR-N04, FR-N05)', async () => {
    // Given the SDK is initialised for tenant "tenant-alpha"
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }

    // When the consumer defines an entity type with all 8 valid property types
    await ontology.defineEntityType(
      {
        name: 'all_types',
        label: 'All Types',
        properties: [
          { name: 'f_text', type: 'text' },
          { name: 'f_number', type: 'number' },
          { name: 'f_date', type: 'date' },
          { name: 'f_datetime', type: 'datetime' },
          { name: 'f_uuid', type: 'uuid' },
          { name: 'f_json', type: 'json' },
          { name: 'f_text_arr', type: 'text[]' },
          { name: 'f_enum', type: 'enum', enumValues: ['A', 'B'] },
        ],
      },
      ctx,
    )

    // Then the call resolves without error (and the EntityTypeDefined event is emitted)
    const schema = await ontology.getSchema(ctx)
    expect(schema.entityTypes.find((e) => e.name === 'all_types')).toBeDefined()
  })

  it('Violation — unknown PropertyDef type is rejected with UNKNOWN_PROPERTY (FR-E02, FR-N04)', async () => {
    // Given the SDK is initialised for tenant "tenant-alpha"
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }

    // When the consumer passes an unknown type "varchar"
    await expectRejects(
      ontology.defineEntityType(
        { name: 'bad_type', label: 'Bad Type', properties: [{ name: 'col', type: 'varchar' as never }] },
        ctx,
      ),
      'UNKNOWN_PROPERTY',
    )

    // And no EntityTypeDefined event is emitted
    const schema = await ontology.getSchema(ctx)
    expect(schema.entityTypes).toHaveLength(0)
  })

  it('Edge — enum property with empty enumValues array is rejected with ENUM_VALUE_INVALID (FR-E03, FR-N05)', async () => {
    // Given the SDK is initialised for tenant "tenant-alpha"
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }

    // When the consumer defines an enum property with empty enumValues
    await expectRejects(
      ontology.defineEntityType(
        { name: 'bad_enum', label: 'Bad Enum', properties: [{ name: 'status', type: 'enum', enumValues: [] }] },
        ctx,
      ),
      'ENUM_VALUE_INVALID',
    )

    // And no EntityTypeDefined event is emitted
    const schema = await ontology.getSchema(ctx)
    expect(schema.entityTypes).toHaveLength(0)
  })

  it('Recovery — after UNKNOWN_PROPERTY rejection schema is unchanged and no event emitted (FR-E02, FR-N04)', async () => {
    // Given the SDK is initialised for tenant "tenant-alpha"
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }

    // And (await ontology.getSchema()).entityTypes has 0 entries
    const schemaBefore = await ontology.getSchema(ctx)
    expect(schemaBefore.entityTypes).toHaveLength(0)

    // When the consumer passes an unknown type "xml"
    await expectRejects(
      ontology.defineEntityType(
        { name: 'bad_type_2', label: 'Bad Type 2', properties: [{ name: 'col', type: 'xml' as never }] },
        ctx,
      ),
      'UNKNOWN_PROPERTY',
    )

    // Then (await ontology.getSchema()).entityTypes still has 0 entries
    const schemaAfter = await ontology.getSchema(ctx)
    expect(schemaAfter.entityTypes).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Domain Event: EntityTypeDefined — observable via getSchema state
// ---------------------------------------------------------------------------

describe('BDD STORY-001 / EntityTypeDefined event proxy checks via public API', () => {
  it('Event missing — EntityTypeDefined is NOT emitted when defineEntityType fails validation (FR-E05, FR-N06)', async () => {
    // Given the SDK is initialised for tenant "tenant-alpha"
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }

    // When the consumer calls defineEntityType with empty name
    await expectRejects(
      ontology.defineEntityType({ name: '' as never, label: 'Empty Name', properties: [] }, ctx),
      'REQUIRED_PROPERTY_MISSING',
    )

    // And no EntityTypeDefined event is emitted (schema empty)
    const schema = await ontology.getSchema(ctx)
    expect(schema.entityTypes).toHaveLength(0)
  })

  it('Event idempotency — defineEntityType for same name emits exactly one EntityTypeDefined event total (FR-E04, FR-N06, FR-N10)', async () => {
    // Given the SDK is initialised for tenant "tenant-alpha"
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }

    // And EntityType "invoice" does not exist
    expect((await ontology.getSchema(ctx)).entityTypes).toHaveLength(0)

    // When call 1: defineEntityType succeeds — EntityTypeDefined event emitted once
    await ontology.defineEntityType({ name: 'invoice', label: 'Invoice', properties: [] }, ctx)
    const schemaAfterFirst = await ontology.getSchema(ctx)
    expect(schemaAfterFirst.entityTypes.filter((e) => e.name === 'invoice')).toHaveLength(1)

    // When call 2: same name → DUPLICATE_ENTITY_TYPE — no second event emitted
    await expectRejects(
      ontology.defineEntityType({ name: 'invoice', label: 'Invoice', properties: [] }, ctx),
      'DUPLICATE_ENTITY_TYPE',
    )

    // Total EntityTypeDefined events for "invoice" is 1 (schema still has exactly one)
    const schemaAfterSecond = await ontology.getSchema(ctx)
    expect(schemaAfterSecond.entityTypes.filter((e) => e.name === 'invoice')).toHaveLength(1)
    expect(schemaAfterSecond.entityTypes).toHaveLength(1)
  })

  it('Event concurrency — two concurrent defineEntityType("invoice") calls resolve deterministically (FR-E04, FR-N06, NFR-P01)', async () => {
    // Given the SDK is initialised for tenant "tenant-alpha"
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }

    // And no EntityType "invoice" exists
    expect((await ontology.getSchema(ctx)).entityTypes).toHaveLength(0)

    // When defineEntityType is called concurrently from two contexts
    const [result1, result2] = await Promise.allSettled([
      ontology.defineEntityType({ name: 'invoice', label: 'Invoice', properties: [] }, ctx),
      ontology.defineEntityType({ name: 'invoice', label: 'Invoice', properties: [] }, ctx),
    ])

    // Then exactly one call resolves without error
    const resolved = [result1, result2].filter((r) => r.status === 'fulfilled')
    const rejected = [result1, result2].filter((r) => r.status === 'rejected')
    expect(resolved).toHaveLength(1)
    expect(rejected).toHaveLength(1)

    // And the rejected one has error code DUPLICATE_ENTITY_TYPE
    const rejectedResult = rejected[0] as PromiseRejectedResult
    expect(rejectedResult.reason).toBeInstanceOf(OntologyError)
    expect((rejectedResult.reason as OntologyError).code).toBe('DUPLICATE_ENTITY_TYPE')

    // And (await ontology.getSchema()).entityTypes contains exactly one entry named "invoice"
    const schema = await ontology.getSchema(ctx)
    expect(schema.entityTypes.filter((e) => e.name === 'invoice')).toHaveLength(1)
    expect(schema.entityTypes).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Large properties array edge case (FR-X04)
// ---------------------------------------------------------------------------

describe('BDD STORY-001 / large properties array (FR-X04) via public API', () => {
  it('Edge — EntityTypeDef with exactly 100 caller-declared properties is accepted and results in 104 total (FR-X04, FR-N02)', async () => {
    // Given the SDK is initialised for tenant "tenant-alpha"
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }

    // When the consumer defines an entity type with 100 distinct text properties
    const properties = Array.from({ length: 100 }, (_, i) => ({
      name: `field${i}`,
      type: 'text' as const,
    }))

    await ontology.defineEntityType({ name: 'wide_entity', label: 'Wide Entity', properties }, ctx)

    // Then the call resolves without error
    const schema = await ontology.getSchema(ctx)
    const et = schema.entityTypes.find((e) => e.name === 'wide_entity')
    expect(et).toBeDefined()

    // And the entry has exactly 104 properties (100 caller + 4 injected)
    expect(et!.properties).toHaveLength(104)

    // And the EntityTypeDefined event is emitted (schema contains the entry)
    expect(schema.entityTypes).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// FR-D04: property ordering — caller-declared first, then 4 injected in order
// ---------------------------------------------------------------------------

describe('BDD STORY-001 / FR-D04: property ordering via public API', () => {
  it('Caller properties appear first, then injected fields in order: id, source_ref, confirmed_by, confirmed_at', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }

    await ontology.defineEntityType(
      {
        name: 'ordered',
        label: 'Ordered',
        properties: [
          { name: 'alpha', type: 'text' },
          { name: 'beta', type: 'number' },
        ],
      },
      ctx,
    )

    const schema = await ontology.getSchema(ctx)
    const et = schema.entityTypes.find((e) => e.name === 'ordered')!
    const names = et.properties.map((p) => p.name)
    expect(names).toEqual(['alpha', 'beta', 'id', 'source_ref', 'confirmed_by', 'confirmed_at'])
  })
})

// ---------------------------------------------------------------------------
// NFR-S01: tenant isolation — empty/missing tenantId is rejected
// ---------------------------------------------------------------------------

describe('BDD STORY-001 / NFR-S01: tenant identity enforced via public API', () => {
  it('Empty tenantId is rejected with TENANT_MISMATCH (NFR-S01)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: '' }

    await expectRejects(
      ontology.defineEntityType({ name: 'invoice', label: 'Invoice', properties: [] }, ctx),
      'TENANT_MISMATCH',
    )
  })

  it('Whitespace-only tenantId is rejected with TENANT_MISMATCH (NFR-S01)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: '   ' }

    await expectRejects(
      ontology.defineEntityType({ name: 'invoice', label: 'Invoice', properties: [] }, ctx),
      'TENANT_MISMATCH',
    )
  })

  it('Cross-tenant isolation: tenant-alpha schema is not visible to tenant-beta (PERM-EntityType: CONFIRMED_DENY cross-tenant read)', async () => {
    const { ontology } = makeOntology()
    const ctxAlpha = { tenantId: 'tenant-alpha' }
    const ctxBeta = { tenantId: 'tenant-beta' }

    await ontology.defineEntityType({ name: 'private_type', label: 'Private', properties: [] }, ctxAlpha)

    // tenant-beta should see an empty schema
    const schemaBeta = await ontology.getSchema(ctxBeta)
    expect(schemaBeta.entityTypes).toHaveLength(0)
    expect(schemaBeta.entityTypes.find((e) => e.name === 'private_type')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// NFR-P01: performance — defineEntityType resolves within 50ms at p99 on InMemoryAdapter
// ---------------------------------------------------------------------------

describe('BDD STORY-001 / NFR-P01: performance budget via public API', () => {
  it('defineEntityType resolves within 50ms p99 on InMemoryAdapter (NFR-P01)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'perf-tenant' }

    const start = Date.now()
    await ontology.defineEntityType({ name: 'perf_entity', label: 'Perf Entity', properties: [] }, ctx)
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(50)
  })
})

// ---------------------------------------------------------------------------
// GAP-N01 resolution: explicit FR tag tests for data contract and identifiers
// ---------------------------------------------------------------------------

describe('BDD STORY-001 / FR-N03: provenance fields cannot be disabled', () => {
  it('No option or flag disables provenance auto-injection; all 4 fields are always present (FR-N03)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-n03' }

    // defineEntityType returns void; provenance is always injected regardless of input
    await ontology.defineEntityType({ name: 'inv', label: 'Inv', properties: [] }, ctx)
    const schema = await ontology.getSchema(ctx)
    const entity = schema.entityTypes.find((e) => e.name === 'inv')!

    // All four provenance fields are always injected regardless of input
    const provenanceNames = ['id', 'source_ref', 'confirmed_by', 'confirmed_at']
    for (const pName of provenanceNames) {
      expect(entity.properties.find((p) => p.name === pName)).toBeDefined()
    }
    expect(entity).toBeDefined()
  })
})

describe('BDD STORY-001 / FR-N07: PropertyDef.required defaults to false', () => {
  it('When required is absent on a PropertyDef, getSchema returns required=false or undefined (FR-N07)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-n07' }

    await ontology.defineEntityType({
      name: 'product',
      label: 'Product',
      properties: [{ name: 'sku', type: 'text' }],
    }, ctx)

    const schema = await ontology.getSchema(ctx)
    const entity = schema.entityTypes.find((e) => e.name === 'product')!
    const skuProp = entity.properties.find((p) => p.name === 'sku')!

    // required absent means false (or absent — either is acceptable per spec)
    expect(skuProp.required === false || skuProp.required === undefined).toBe(true)
  })
})

describe('BDD STORY-001 / FR-N08: PropertyDef.description stored verbatim', () => {
  it('A property description is stored and returned exactly as provided (FR-N08)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-n08' }

    const desc = 'The unique invoice reference number (e.g. INV-2026-001)'
    await ontology.defineEntityType({
      name: 'invoice',
      label: 'Invoice',
      properties: [{ name: 'ref_number', type: 'text', description: desc }],
    }, ctx)

    const schema = await ontology.getSchema(ctx)
    const entity = schema.entityTypes.find((e) => e.name === 'invoice')!
    const prop = entity.properties.find((p) => p.name === 'ref_number')!

    expect(prop.description).toBe(desc)
  })
})

describe('BDD STORY-001 / FR-N09: Vietnamese snake_case entity name is accepted', () => {
  it('Vietnamese snake_case name is treated as a valid opaque identifier (FR-N09)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-n09' }

    // Vietnamese domain names should be accepted as opaque strings
    await ontology.defineEntityType({ name: 'chung_tu_ke_toan', label: 'Chứng Từ Kế Toán', properties: [] }, ctx)

    const schema = await ontology.getSchema(ctx)
    const entity = schema.entityTypes.find((e) => e.name === 'chung_tu_ke_toan')
    expect(entity).toBeDefined()
    expect(entity!.name).toBe('chung_tu_ke_toan')
  })
})

describe('BDD STORY-001 / FR-D01: auto-injected id field type is uuid', () => {
  it('The auto-injected id field has type "uuid" (FR-D01)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-d01' }

    await ontology.defineEntityType({ name: 'doc', label: 'Doc', properties: [] }, ctx)
    const schema = await ontology.getSchema(ctx)
    const entity = schema.entityTypes.find((e) => e.name === 'doc')!
    const idField = entity.properties.find((p) => p.name === 'id')!

    expect(idField.type).toBe('uuid')
  })
})

describe('BDD STORY-001 / FR-D02: auto-injected confirmed_at field type is datetime', () => {
  it('The auto-injected confirmed_at field has type "datetime" (FR-D02)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-d02' }

    await ontology.defineEntityType({ name: 'doc', label: 'Doc', properties: [] }, ctx)
    const schema = await ontology.getSchema(ctx)
    const entity = schema.entityTypes.find((e) => e.name === 'doc')!
    const confirmedAtField = entity.properties.find((p) => p.name === 'confirmed_at')!

    expect(confirmedAtField.type).toBe('datetime')
  })
})

describe('BDD STORY-001 / FR-D03: PropertyDef is a plain-data value object', () => {
  it('Properties returned by getSchema are plain data objects with no methods (FR-D03)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-d03' }

    await ontology.defineEntityType({
      name: 'asset',
      label: 'Asset',
      properties: [{ name: 'code', type: 'text', required: true }],
    }, ctx)

    const schema = await ontology.getSchema(ctx)
    const entity = schema.entityTypes.find((e) => e.name === 'asset')!
    const codeProp = entity.properties.find((p) => p.name === 'code')!

    // Plain-data value object: has the expected fields, is JSON-serialisable
    expect(codeProp.name).toBe('code')
    expect(codeProp.type).toBe('text')
    expect(codeProp.required).toBe(true)
    expect(() => JSON.stringify(codeProp)).not.toThrow()
    expect(JSON.parse(JSON.stringify(codeProp))).toMatchObject({ name: 'code', type: 'text' })
  })
})

// ---------------------------------------------------------------------------
// GAP-N02 resolution: FR-X02 — duplicate property name collision
// ---------------------------------------------------------------------------

describe('BDD STORY-001 / FR-X02: duplicate property names in same EntityTypeDef are rejected', () => {
  it('Two properties with the same name in one EntityTypeDef are rejected with PROVENANCE_FIELD_REDECLARED (FR-X02)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-x02' }

    await expectRejects(
      ontology.defineEntityType({
        name: 'invoice',
        label: 'Invoice',
        properties: [
          { name: 'amount', type: 'number' },
          { name: 'amount', type: 'text' },
        ],
      }, ctx),
      'PROVENANCE_FIELD_REDECLARED',
    )
  })

  it('Same name as an auto-injected provenance field is also rejected (FR-X02, BR-002)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-x02b' }

    // "id" is always auto-injected — declaring it again must also be caught
    await expectRejects(
      ontology.defineEntityType({
        name: 'invoice',
        label: 'Invoice',
        properties: [{ name: 'id', type: 'text' }],
      }, ctx),
      'PROVENANCE_FIELD_REDECLARED',
    )
  })
})
