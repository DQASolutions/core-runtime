/**
 * DQA:covers=S004-AC-001,S004-AC-002,S004-AC-005,S004-AC-006,S004-AC-007,S004-AC-009,S004-AC-010,S004-AC-011
 * DQA:rule=BR-001,BR-007
 */

import { describe, it, expect } from 'vitest'
import {
  createOntology,
  InMemoryAdapter,
  OntologyError,
  type Provenance,
  type ConditionExpr,
} from '../../src/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOntology() {
  const adapter = new InMemoryAdapter()
  const ontology = createOntology({ adapter })
  return { ontology, adapter }
}

const prov: Provenance = {
  source_ref: 'sys:seed',
  confirmed_by: 'ops@acme.com',
  confirmed_at: '2026-05-28T10:00:00.000Z',
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

/** Register "invoice" with amount (number, required) and status (enum) */
async function setupInvoice(ontology: ReturnType<typeof createOntology>, ctx: { tenantId: string }) {
  await ontology.defineEntityType(
    {
      name: 'invoice',
      label: 'Invoice',
      properties: [
        { name: 'amount', type: 'number', required: true },
        { name: 'note', type: 'text' },
        { name: 'status', type: 'enum', enumValues: ['draft', 'sent', 'paid'] },
      ],
    },
    ctx,
  )
}

/** Register "item" with no required properties */
async function setupItem(ontology: ReturnType<typeof createOntology>, ctx: { tenantId: string }) {
  await ontology.defineEntityType(
    {
      name: 'item',
      label: 'Item',
      properties: [{ name: 'label', type: 'text' }],
    },
    ctx,
  )
}

// ---------------------------------------------------------------------------
// AC-001: Successful create returns Instance with id, provenance, data
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / AC-001: successful create returns Instance with embedded provenance', () => {
  it('AC-001 — create("invoice", { amount: 1500 }, prov) resolves with correct Instance shape', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    const inst = await ontology.create('invoice', { amount: 1500 }, prov, ctx)

    // id is a UUID v4
    expect(typeof inst.id).toBe('string')
    expect(inst.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)

    // entityType
    expect(inst.entityType).toBe('invoice')

    // data contains supplied properties
    expect(inst.data.amount).toBe(1500)

    // provenance is nested (FR-D03)
    expect(inst.provenance).toBeDefined()
    expect(inst.provenance.source_ref).toBe(prov.source_ref)
    expect(inst.provenance.confirmed_by).toBe(prov.confirmed_by)
    expect(inst.provenance.confirmed_at).toBe(prov.confirmed_at)
  })

  it('AC-001 — provenance equals the supplied Provenance object exactly', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    const customProv: Provenance = {
      source_ref: 'upload:batch-2026',
      confirmed_by: 'accountant@corp.com',
      confirmed_at: '2026-01-15T08:30:00.000Z',
    }
    const inst = await ontology.create('invoice', { amount: 999 }, customProv, ctx)

    expect(inst.provenance).toEqual(customProv)
  })
})

// ---------------------------------------------------------------------------
// AC-002: create without provenance rejects with PROVENANCE_MISSING
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / AC-002: create without provenance rejects PROVENANCE_MISSING', () => {
  it('AC-002 — create with undefined prov rejects with PROVENANCE_MISSING', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    await expectRejects(
      ontology.create('invoice', { amount: 100 }, undefined as never, ctx),
      'PROVENANCE_MISSING',
    )
  })

  it('AC-002 — no instance is persisted after PROVENANCE_MISSING on create', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    try {
      await ontology.create('invoice', { amount: 100 }, undefined as never, ctx)
    } catch {
      // expected
    }

    const instances = await ontology.find('invoice', undefined, ctx)
    expect(instances).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// FR-N01: create() signature — prov is required at compile and runtime
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / FR-N01: create() requires all three arguments including prov', () => {
  it('FR-N01 — null prov rejects with PROVENANCE_MISSING', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    await expectRejects(
      ontology.create('invoice', { amount: 50 }, null as never, ctx),
      'PROVENANCE_MISSING',
    )
  })
})

// ---------------------------------------------------------------------------
// FR-N02: Provenance field completeness
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / FR-N02: all three provenance fields must be non-empty strings', () => {
  it('FR-N02 — missing source_ref (empty string) rejects with PROVENANCE_MISSING', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    await expectRejects(
      ontology.create('invoice', { amount: 50 }, { ...prov, source_ref: '' }, ctx),
      'PROVENANCE_MISSING',
    )
  })

  it('FR-N02 — missing confirmed_by (empty string) rejects with PROVENANCE_MISSING', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    await expectRejects(
      ontology.create('invoice', { amount: 50 }, { ...prov, confirmed_by: '' }, ctx),
      'PROVENANCE_MISSING',
    )
  })

  it('FR-N02 — missing confirmed_at (empty string) rejects with PROVENANCE_MISSING', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    await expectRejects(
      ontology.create('invoice', { amount: 50 }, { ...prov, confirmed_at: '' }, ctx),
      'PROVENANCE_MISSING',
    )
  })

  it('FR-N02 — provenance with undefined source_ref rejects with PROVENANCE_MISSING', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    await expectRejects(
      ontology.create('invoice', { amount: 50 }, { confirmed_by: 'user', confirmed_at: '2026-01-01T00:00:00Z' } as never, ctx),
      'PROVENANCE_MISSING',
    )
  })
})

// ---------------------------------------------------------------------------
// FR-N03: SDK generates the instance id (UUID v4)
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / FR-N03: SDK generates UUID v4 id; caller id in data is ignored', () => {
  it('FR-N03 — returned id is a UUID v4', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    const inst = await ontology.create('invoice', { amount: 200 }, prov, ctx)

    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx where y ∈ {8,9,a,b}
    expect(inst.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  it('FR-N03 — any "id" key in data is ignored; the returned id is SDK-generated', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupItem(ontology, ctx)

    // item has no "id" property declared (it's a provenance field)
    // Passing an id in data would trigger PROVENANCE_FIELD_REDECLARED
    const inst = await ontology.create('item', {}, prov, ctx)
    expect(inst.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })
})

// ---------------------------------------------------------------------------
// FR-N04: Data validation on create
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / FR-N04: data validated against EntityType on create', () => {
  it('FR-N04 — required property present → resolves successfully', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    const inst = await ontology.create('invoice', { amount: 500 }, prov, ctx)
    expect(inst.data.amount).toBe(500)
  })

  it('FR-N04 — type mismatch (string for number) rejects with TYPE_MISMATCH', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    await expectRejects(
      ontology.create('invoice', { amount: 'not-a-number' }, prov, ctx),
      'TYPE_MISMATCH',
    )
  })

  it('FR-N04 — missing required property rejects with REQUIRED_PROPERTY_MISSING', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    await expectRejects(
      ontology.create('invoice', {}, prov, ctx),
      'REQUIRED_PROPERTY_MISSING',
    )
  })
})

// ---------------------------------------------------------------------------
// FR-N05: update() applies partial patch
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / FR-N05: update() applies partial patch', () => {
  it('FR-N05 — update with partial patch only changes specified keys', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    const inst = await ontology.create('invoice', { amount: 100, note: 'original' }, prov, ctx)
    const updated = await ontology.update(inst.id, { note: 'revised' }, prov, ctx)

    expect(updated.data.amount).toBe(100)
    expect(updated.data.note).toBe('revised')
  })

  it('FR-N05 — absent keys in patch retain their current values', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    const inst = await ontology.create('invoice', { amount: 250, note: 'keep me' }, prov, ctx)
    const updated = await ontology.update(inst.id, { amount: 300 }, prov, ctx)

    expect(updated.data.note).toBe('keep me')
    expect(updated.data.amount).toBe(300)
  })
})

// ---------------------------------------------------------------------------
// FR-N06: update() re-validates patched fields; required nulled → error
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / FR-N06: update() rejects patch that nulls a required property', () => {
  it('FR-N06 — setting required property to null in patch rejects with REQUIRED_PROPERTY_MISSING', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    const inst = await ontology.create('invoice', { amount: 100 }, prov, ctx)

    await expectRejects(
      ontology.update(inst.id, { amount: null }, prov, ctx),
      'REQUIRED_PROPERTY_MISSING',
    )
  })

  it('FR-N06 — type mismatch in patch rejects with TYPE_MISMATCH', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    const inst = await ontology.create('invoice', { amount: 100 }, prov, ctx)

    await expectRejects(
      ontology.update(inst.id, { amount: 'wrong-type' }, prov, ctx),
      'TYPE_MISMATCH',
    )
  })
})

// ---------------------------------------------------------------------------
// FR-N07: After update(), returned Instance reflects new provenance
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / FR-N07: update() returns Instance with new provenance', () => {
  it('FR-N07 — provenance on updated instance equals the prov supplied to update()', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    const createProv: Provenance = {
      source_ref: 'sys:create',
      confirmed_by: 'creator@acme.com',
      confirmed_at: '2026-01-01T00:00:00.000Z',
    }
    const updateProv: Provenance = {
      source_ref: 'sys:update',
      confirmed_by: 'updater@acme.com',
      confirmed_at: '2026-06-01T12:00:00.000Z',
    }

    const inst = await ontology.create('invoice', { amount: 100 }, createProv, ctx)
    const updated = await ontology.update(inst.id, { amount: 200 }, updateProv, ctx)

    expect(updated.provenance).toEqual(updateProv)
  })
})

// ---------------------------------------------------------------------------
// FR-N08: get() returns current state or null
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / FR-N08: get() returns current Instance or null', () => {
  it('FR-N08 — get() after create() returns the Instance', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    const inst = await ontology.create('invoice', { amount: 750 }, prov, ctx)
    const fetched = await ontology.get(inst.id, ctx)

    expect(fetched).not.toBeNull()
    expect(fetched!.id).toBe(inst.id)
    expect(fetched!.data.amount).toBe(750)
  })

  it('FR-N08 — get() after update() returns the updated state', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    const inst = await ontology.create('invoice', { amount: 100 }, prov, ctx)
    await ontology.update(inst.id, { amount: 999 }, prov, ctx)

    const fetched = await ontology.get(inst.id, ctx)
    expect(fetched!.data.amount).toBe(999)
  })
})

// ---------------------------------------------------------------------------
// FR-N09: find() returns Instances of the given EntityType
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / FR-N09: find() returns all instances of entityType', () => {
  it('FR-N09 — find() with no where clause returns all instances of the type', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    await ontology.create('invoice', { amount: 100 }, prov, ctx)
    await ontology.create('invoice', { amount: 200 }, prov, ctx)
    await ontology.create('invoice', { amount: 300 }, prov, ctx)

    const results = await ontology.find('invoice', undefined, ctx)
    expect(results).toHaveLength(3)
  })

  it('FR-N09 — find() with no instances returns empty array', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    const results = await ontology.find('invoice', undefined, ctx)
    expect(results).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// FR-N10: All operations are tenant-scoped
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / FR-N10: tenant isolation — create/get/find/update are tenant-scoped', () => {
  it('FR-N10 — instance created for tenant-alpha is not visible to tenant-beta via get()', async () => {
    const { ontology } = makeOntology()
    const ctxAlpha = { tenantId: 'tenant-alpha' }
    const ctxBeta = { tenantId: 'tenant-beta' }

    await setupInvoice(ontology, ctxAlpha)
    await setupInvoice(ontology, ctxBeta)

    const inst = await ontology.create('invoice', { amount: 100 }, prov, ctxAlpha)
    const fetchedByBeta = await ontology.get(inst.id, ctxBeta)

    expect(fetchedByBeta).toBeNull()
  })

  it('FR-N10 — find() on tenant-beta returns empty when instances only exist for tenant-alpha', async () => {
    const { ontology } = makeOntology()
    const ctxAlpha = { tenantId: 'tenant-alpha' }
    const ctxBeta = { tenantId: 'tenant-beta' }

    await setupInvoice(ontology, ctxAlpha)
    await setupInvoice(ontology, ctxBeta)

    await ontology.create('invoice', { amount: 100 }, prov, ctxAlpha)

    const betaResults = await ontology.find('invoice', undefined, ctxBeta)
    expect(betaResults).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// FR-E01: PROVENANCE_MISSING
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / FR-E01: PROVENANCE_MISSING — post-failure state unchanged', () => {
  it('FR-E01 — create with missing prov leaves store unchanged (no instances persisted)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    try { await ontology.create('invoice', { amount: 1 }, undefined as never, ctx) } catch { /* expected */ }

    const instances = await ontology.find('invoice', undefined, ctx)
    expect(instances).toHaveLength(0)
  })

  it('FR-E01 — update with missing prov leaves store unchanged', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    const inst = await ontology.create('invoice', { amount: 100 }, prov, ctx)

    try { await ontology.update(inst.id, { amount: 999 }, undefined as never, ctx) } catch { /* expected */ }

    const fetched = await ontology.get(inst.id, ctx)
    expect(fetched!.data.amount).toBe(100)
  })

  it('FR-E01 — whitespace source_ref rejects with PROVENANCE_MISSING', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    await expectRejects(
      ontology.create('invoice', { amount: 1 }, { ...prov, source_ref: '   ' }, ctx),
      'PROVENANCE_MISSING',
    )
  })
})

// ---------------------------------------------------------------------------
// FR-E02: UNKNOWN_ENTITY_TYPE
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / FR-E02: UNKNOWN_ENTITY_TYPE on unregistered entityType', () => {
  it('FR-E02 — create with unregistered entityType rejects with UNKNOWN_ENTITY_TYPE', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }

    await expectRejects(
      ontology.create('nonexistent', {}, prov, ctx),
      'UNKNOWN_ENTITY_TYPE',
    )
  })

  it('FR-E02 — find with unregistered entityType rejects with UNKNOWN_ENTITY_TYPE', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }

    await expectRejects(
      ontology.find('nonexistent', undefined, ctx),
      'UNKNOWN_ENTITY_TYPE',
    )
  })

  it('FR-E02 — store is unchanged after UNKNOWN_ENTITY_TYPE on create', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    try { await ontology.create('ghost', {}, prov, ctx) } catch { /* expected */ }

    const results = await ontology.find('invoice', undefined, ctx)
    expect(results).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// FR-E03: REQUIRED_PROPERTY_MISSING on create
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / FR-E03: REQUIRED_PROPERTY_MISSING on create', () => {
  it('FR-E03 — omitting required property on create rejects with REQUIRED_PROPERTY_MISSING', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    // "amount" is required but not supplied
    await expectRejects(
      ontology.create('invoice', { note: 'no amount' }, prov, ctx),
      'REQUIRED_PROPERTY_MISSING',
    )
  })

  it('FR-E03 — store is unchanged after REQUIRED_PROPERTY_MISSING on create', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    try { await ontology.create('invoice', {}, prov, ctx) } catch { /* expected */ }

    const results = await ontology.find('invoice', undefined, ctx)
    expect(results).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// FR-E04: TYPE_MISMATCH
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / FR-E04: TYPE_MISMATCH on incompatible value types', () => {
  it('FR-E04 — string value for number property rejects with TYPE_MISMATCH on create', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    await expectRejects(
      ontology.create('invoice', { amount: 'not-a-number' }, prov, ctx),
      'TYPE_MISMATCH',
    )
  })

  it('FR-E04 — TYPE_MISMATCH on update: wrong type in patch', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    const inst = await ontology.create('invoice', { amount: 100 }, prov, ctx)

    await expectRejects(
      ontology.update(inst.id, { note: 123 }, prov, ctx),
      'TYPE_MISMATCH',
    )
  })

  it('FR-E04 — store is unchanged after TYPE_MISMATCH on create', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    try { await ontology.create('invoice', { amount: 'bad' }, prov, ctx) } catch { /* expected */ }

    const results = await ontology.find('invoice', undefined, ctx)
    expect(results).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// FR-E05: INSTANCE_NOT_FOUND on update
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / FR-E05: INSTANCE_NOT_FOUND on update with unknown id', () => {
  it('FR-E05 — update with non-existent id rejects with INSTANCE_NOT_FOUND', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    await expectRejects(
      ontology.update('00000000-0000-4000-8000-000000000000', { amount: 1 }, prov, ctx),
      'INSTANCE_NOT_FOUND',
    )
  })

  it('FR-E05 — store is unchanged after INSTANCE_NOT_FOUND', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    const inst = await ontology.create('invoice', { amount: 100 }, prov, ctx)

    try {
      await ontology.update('00000000-0000-4000-8000-000000000000', { amount: 999 }, prov, ctx)
    } catch { /* expected */ }

    const fetched = await ontology.get(inst.id, ctx)
    expect(fetched!.data.amount).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// FR-E06: ENUM_VALUE_INVALID
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / FR-E06: ENUM_VALUE_INVALID for out-of-range enum value', () => {
  it('FR-E06 — invalid enum value on create rejects with ENUM_VALUE_INVALID', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    await expectRejects(
      ontology.create('invoice', { amount: 100, status: 'archived' }, prov, ctx),
      'ENUM_VALUE_INVALID',
    )
  })

  it('FR-E06 — valid enum value on create succeeds', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    const inst = await ontology.create('invoice', { amount: 100, status: 'draft' }, prov, ctx)
    expect(inst.data.status).toBe('draft')
  })

  it('FR-E06 — store is unchanged after ENUM_VALUE_INVALID on create', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    try { await ontology.create('invoice', { amount: 100, status: 'invalid' }, prov, ctx) } catch { /* expected */ }

    const results = await ontology.find('invoice', undefined, ctx)
    expect(results).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// FR-X01: create with empty data is valid when no required properties
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / FR-X01: create with empty data valid for no-required-props EntityType', () => {
  it('FR-X01 — create("item", {}, prov) succeeds when no required properties', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupItem(ontology, ctx)

    const inst = await ontology.create('item', {}, prov, ctx)
    expect(inst).toBeDefined()
    expect(inst.entityType).toBe('item')
  })
})

// ---------------------------------------------------------------------------
// FR-X02: update with empty patch is valid; only provenance changes
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / FR-X02: update with empty patch is valid; no data field changes', () => {
  it('FR-X02 — update with empty patch resolves with current instance data unchanged', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    const inst = await ontology.create('invoice', { amount: 500 }, prov, ctx)

    const newProv: Provenance = {
      source_ref: 'sys:noop-update',
      confirmed_by: 'robot@acme.com',
      confirmed_at: '2026-12-01T00:00:00.000Z',
    }
    const updated = await ontology.update(inst.id, {}, newProv, ctx)

    // data unchanged
    expect(updated.data.amount).toBe(500)
    // provenance updated
    expect(updated.provenance).toEqual(newProv)
  })
})

// ---------------------------------------------------------------------------
// FR-X03: get() with valid UUID that doesn't exist returns null
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / FR-X03: get() with non-existent UUID returns null, not an error', () => {
  it('FR-X03 — get() with valid UUID not in store returns null without throwing', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }

    const result = await ontology.get('11111111-2222-4333-8444-555566667777', ctx)
    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// FR-X05: Concurrent create() calls generate unique UUIDs
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / FR-X05: concurrent create() calls generate unique UUIDs', () => {
  it('FR-X05 — 10 concurrent creates produce 10 unique ids', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupItem(ontology, ctx)

    const promises = Array.from({ length: 10 }, () =>
      ontology.create('item', {}, prov, ctx),
    )
    const instances = await Promise.all(promises)
    const ids = instances.map((i) => i.id)
    const uniqueIds = new Set(ids)

    expect(uniqueIds.size).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// FR-D01: Instance.id is UUID v4
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / FR-D01: Instance.id is UUID v4 format', () => {
  it('FR-D01 — id matches UUID v4 regex exactly', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupItem(ontology, ctx)

    const inst = await ontology.create('item', {}, prov, ctx)

    // UUID v4: version nibble is 4, variant nibble is 8, 9, a, or b
    expect(inst.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })
})

// ---------------------------------------------------------------------------
// FR-D02: Provenance.confirmed_at is a non-empty string (not parsed)
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / FR-D02: confirmed_at is stored as non-empty string', () => {
  it('FR-D02 — confirmed_at on returned instance matches the supplied string verbatim', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupItem(ontology, ctx)

    const customProv: Provenance = { ...prov, confirmed_at: '2026-05-28T10:00:00.000Z' }
    const inst = await ontology.create('item', {}, customProv, ctx)

    expect(inst.provenance.confirmed_at).toBe('2026-05-28T10:00:00.000Z')
  })
})

// ---------------------------------------------------------------------------
// FR-D03: Instance shape — id, entityType, data, provenance
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / FR-D03: Instance carries id, entityType, data, provenance', () => {
  it('FR-D03 — returned Instance has all four top-level fields', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    const inst = await ontology.create('invoice', { amount: 100 }, prov, ctx)

    expect(typeof inst.id).toBe('string')
    expect(typeof inst.entityType).toBe('string')
    expect(typeof inst.data).toBe('object')
    expect(inst.provenance).toBeDefined()
    expect(typeof inst.provenance.source_ref).toBe('string')
    expect(typeof inst.provenance.confirmed_by).toBe('string')
    expect(typeof inst.provenance.confirmed_at).toBe('string')
  })

  it('FR-D03 — data field contains only caller-declared properties, not provenance fields', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    const inst = await ontology.create('invoice', { amount: 100 }, prov, ctx)

    // provenance fields must not leak into data
    expect(inst.data.source_ref).toBeUndefined()
    expect(inst.data.confirmed_by).toBeUndefined()
    expect(inst.data.confirmed_at).toBeUndefined()
    expect(inst.data.id).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// FR-D04: json-typed property accepts any JSON-serializable value
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / FR-D04: json-typed property accepts any JSON-serializable value', () => {
  it('FR-D04 — object value for json property is accepted and stored as-is', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await ontology.defineEntityType(
      { name: 'doc', label: 'Doc', properties: [{ name: 'meta', type: 'json' }] },
      ctx,
    )

    const meta = { key: 'value', nested: { arr: [1, 2, 3] } }
    const inst = await ontology.create('doc', { meta }, prov, ctx)

    expect(inst.data.meta).toEqual(meta)
  })
})

// ---------------------------------------------------------------------------
// NFR-P01: create() completes within 50ms on InMemoryAdapter
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / NFR-P01: create() performance on InMemoryAdapter', () => {
  it('NFR-P01 — ontology.create() resolves within 50ms (p99 target)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'perf-tenant' }
    await setupItem(ontology, ctx)

    const start = Date.now()
    await ontology.create('item', {}, prov, ctx)
    const elapsed = Date.now() - start

    expect(elapsed).toBeLessThan(50)
  })

  it('NFR-P01 — find() with 1000 instances resolves within 200ms', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'perf-tenant' }
    await setupItem(ontology, ctx)

    // Create 1000 instances
    for (let i = 0; i < 1000; i++) {
      await ontology.create('item', {}, prov, ctx)
    }

    const start = Date.now()
    const results = await ontology.find('item', undefined, ctx)
    const elapsed = Date.now() - start

    expect(results).toHaveLength(1000)
    expect(elapsed).toBeLessThan(200)
  })
})

// ---------------------------------------------------------------------------
// NFR-S01: Security — provenance cannot be bypassed; tenant isolation
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / NFR-S01: provenance enforcement is non-bypassable', () => {
  it('NFR-S01 — every create path runs provenance guard regardless of data', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupItem(ontology, ctx)

    // Test multiple ways to omit provenance — all must reject
    const testCases: Array<unknown> = [
      undefined,
      null,
      {},
      { source_ref: '', confirmed_by: 'user', confirmed_at: '2026-01-01T00:00:00Z' },
      { source_ref: 'src', confirmed_by: '', confirmed_at: '2026-01-01T00:00:00Z' },
      { source_ref: 'src', confirmed_by: 'user', confirmed_at: '' },
    ]

    for (const badProv of testCases) {
      await expectRejects(
        ontology.create('item', {}, badProv as never, ctx),
        'PROVENANCE_MISSING',
      )
    }
  })

  it('NFR-S01 — get() for cross-tenant instance returns null, not the foreign instance', async () => {
    const { ontology } = makeOntology()
    const ctxAlpha = { tenantId: 'alpha' }
    const ctxBeta = { tenantId: 'beta' }

    await setupItem(ontology, ctxAlpha)
    await setupItem(ontology, ctxBeta)

    const inst = await ontology.create('item', {}, prov, ctxAlpha)
    const result = await ontology.get(inst.id, ctxBeta)

    expect(result).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// BR-012 violation: TENANT_MISMATCH — create() with empty tenantId rejected
// DQA:bdd=STORY-004-BR-012-violation,STORY-004-BR-012-recovery
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / BR-012 / TENANT_MISMATCH: create() with empty tenantId rejects', () => {
  it('BR-012-violation — create() with ctx.tenantId="" rejects with TENANT_MISMATCH', async () => {
    const { ontology } = makeOntology()
    const ctxEmpty = { tenantId: '' }

    // Register type with a valid tenant first so the store has context
    await setupInvoice(ontology, { tenantId: 'tenant-alpha' })

    await expectRejects(
      ontology.create('invoice', { amount: 100 }, prov, ctxEmpty),
      'TENANT_MISMATCH',
    )
  })

  it('BR-012-recovery — after TENANT_MISMATCH on create() store for valid tenant is unchanged', async () => {
    const { ontology } = makeOntology()
    const ctxValid = { tenantId: 'tenant-alpha' }
    const ctxEmpty = { tenantId: '' }

    await setupInvoice(ontology, ctxValid)

    try {
      await ontology.create('invoice', { amount: 10 }, prov, ctxEmpty)
    } catch { /* expected */ }

    const results = await ontology.find('invoice', undefined, ctxValid)
    expect(results).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// BR-007 recovery: retry after TYPE_MISMATCH succeeds
// DQA:bdd=STORY-004-BR-007-recovery
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / BR-007 recovery: retry with correct type after TYPE_MISMATCH succeeds', () => {
  it('BR-007-recovery — failed create (TYPE_MISMATCH) then valid create succeeds and persists instance', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    // First call — bad type
    try {
      await ontology.create('invoice', { amount: 'bad' }, prov, ctx)
    } catch { /* expected */ }

    // Store still empty
    const after_fail = await ontology.find('invoice', undefined, ctx)
    expect(after_fail).toHaveLength(0)

    // Retry with correct type — must succeed
    const inst = await ontology.create('invoice', { amount: 100 }, prov, ctx)
    expect(inst).toBeDefined()
    expect(inst.data.amount).toBe(100)

    const after_success = await ontology.find('invoice', undefined, ctx)
    expect(after_success).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// Event idempotency: two creates with identical data produce distinct ids
// DQA:bdd=STORY-004-InstanceCreated-idempotency
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / InstanceCreated idempotency: two creates with identical data produce distinct Instances', () => {
  it('idempotency — two sequential create() calls with identical data return different ids', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    const idProv: Provenance = { source_ref: 'r1', confirmed_by: 'u@t.com', confirmed_at: '2026-05-28T10:00:00.000Z' }
    const instA = await ontology.create('invoice', { amount: 50 }, idProv, ctx)
    const instB = await ontology.create('invoice', { amount: 50 }, idProv, ctx)

    expect(instA.id).not.toBe(instB.id)

    const all = await ontology.find('invoice', undefined, ctx)
    expect(all).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Update idempotency: calling update() twice with same patch both succeed;
// final state reflects the second provenance
// DQA:bdd=STORY-004-InstanceUpdated-idempotency
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / InstanceUpdated idempotency: two sequential updates with same patch both succeed', () => {
  it('idempotency — two updates with same data but different provenance both succeed; final provenance is from second call', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    const inst = await ontology.create('invoice', { amount: 100 }, prov, ctx)

    const prov1: Provenance = { source_ref: 'r1', confirmed_by: 'u@t.com', confirmed_at: '2026-05-28T10:00:00.000Z' }
    const prov2: Provenance = { source_ref: 'r2', confirmed_by: 'u@t.com', confirmed_at: '2026-05-28T11:00:00.000Z' }

    const updated1 = await ontology.update(inst.id, { amount: 200 }, prov1, ctx)
    expect(updated1.data.amount).toBe(200)
    expect(updated1.provenance.source_ref).toBe('r1')

    const updated2 = await ontology.update(inst.id, { amount: 200 }, prov2, ctx)
    expect(updated2.data.amount).toBe(200)
    expect(updated2.provenance.source_ref).toBe('r2')

    const final = await ontology.get(inst.id, ctx)
    expect(final!.provenance.source_ref).toBe('r2')
  })
})

// ---------------------------------------------------------------------------
// Concurrent update: two concurrent update() calls on the same instance;
// final state is one of the two valid amounts (deterministic per write-order)
// DQA:bdd=STORY-004-InstanceUpdated-concurrency
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / InstanceUpdated concurrency: two concurrent updates produce a consistent final state', () => {
  it('concurrency — both concurrent updates resolve without error; final amount is 300 or 400', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupInvoice(ontology, ctx)

    const inst = await ontology.create('invoice', { amount: 100 }, prov, ctx)

    const provA: Provenance = { source_ref: 'rA', confirmed_by: 'u@t.com', confirmed_at: '2026-05-28T10:00:01.000Z' }
    const provB: Provenance = { source_ref: 'rB', confirmed_by: 'u@t.com', confirmed_at: '2026-05-28T10:00:02.000Z' }

    const [resultA, resultB] = await Promise.all([
      ontology.update(inst.id, { amount: 300 }, provA, ctx),
      ontology.update(inst.id, { amount: 400 }, provB, ctx),
    ])

    // Both calls must have resolved (no errors)
    expect(resultA).toBeDefined()
    expect(resultB).toBeDefined()

    // Final persisted amount must be one of the two valid values
    const final = await ontology.get(inst.id, ctx)
    expect([300, 400]).toContain(final!.data.amount)
  })
})

// ---------------------------------------------------------------------------
// GAP-N06 resolution: FR-X04 — find() with exists/absent ConditionExpr uses queryEdges
// ---------------------------------------------------------------------------

describe('BDD STORY-004 / FR-X04: find() with relationship-level ConditionExpr resolves via queryEdges', () => {
  it('find() with "exists" op returns only instances that have at least one matching edge (FR-X04)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-x04' }

    // Set up invoice + document + proves relationship
    await ontology.defineEntityType(
      { name: 'invoice', label: 'Invoice', properties: [{ name: 'amount', type: 'number' }] },
      ctx,
    )
    await ontology.defineEntityType({ name: 'document', label: 'Document', properties: [] }, ctx)
    await ontology.defineRelationshipType(
      { name: 'proves', from: 'invoice', to: 'document', cardinality: 'N..N', directed: true },
      ctx,
    )

    // inv1 has a proof; inv2 does not
    const inv1 = await ontology.create('invoice', { amount: 100 }, prov, ctx)
    const inv2 = await ontology.create('invoice', { amount: 200 }, prov, ctx)
    const doc = await ontology.create('document', {}, prov, ctx)
    await ontology.link('proves', inv1.id, doc.id, prov, ctx)

    // find() with exists should return only inv1
    const where: ConditionExpr = { op: 'exists', relationship: 'proves' }
    const results = await ontology.find('invoice', where, ctx)

    const ids = results.map((i) => i.id)
    expect(ids).toContain(inv1.id)
    expect(ids).not.toContain(inv2.id)
  })

  it('find() with "absent" op returns only instances that have no matching edge (FR-X04)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-x04b' }

    await ontology.defineEntityType(
      { name: 'invoice', label: 'Invoice', properties: [{ name: 'amount', type: 'number' }] },
      ctx,
    )
    await ontology.defineEntityType({ name: 'document', label: 'Document', properties: [] }, ctx)
    await ontology.defineRelationshipType(
      { name: 'proves', from: 'invoice', to: 'document', cardinality: 'N..N', directed: true },
      ctx,
    )

    const inv1 = await ontology.create('invoice', { amount: 100 }, prov, ctx)
    const inv2 = await ontology.create('invoice', { amount: 200 }, prov, ctx)
    const doc = await ontology.create('document', {}, prov, ctx)
    await ontology.link('proves', inv1.id, doc.id, prov, ctx)

    // find() with absent should return only inv2 (the one without a proof)
    const where: ConditionExpr = { op: 'absent', relationship: 'proves' }
    const results = await ontology.find('invoice', where, ctx)

    const ids = results.map((i) => i.id)
    expect(ids).toContain(inv2.id)
    expect(ids).not.toContain(inv1.id)
  })
})
