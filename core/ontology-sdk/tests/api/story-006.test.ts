/**
 * DQA:covers=S006-AC-001,S006-AC-002,S006-AC-005,S006-AC-006,S006-AC-007,S006-AC-009,S006-AC-010,S006-AC-011
 * DQA:rule=BR-005,BR-015
 */

import { describe, it, expect } from 'vitest'
import {
  createOntology,
  InMemoryAdapter,
  OntologyError,
  type Provenance,
  type Instance,
  type TraversalResult,
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
  source_ref: 'traverse-test-001',
  confirmed_by: 'qa@dqa',
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

/**
 * Set up a standard test environment matching AC-001/AC-002 Background:
 * - EntityTypes: account, transaction, document
 * - RelationshipTypes: owned_by (account→transaction, N..N, directed), proves (transaction→document, N..1, directed)
 */
async function setupSchema(ontology: ReturnType<typeof createOntology>, ctx: { tenantId: string }) {
  await ontology.defineEntityType({ name: 'account', label: 'Account', properties: [] }, ctx)
  await ontology.defineEntityType({ name: 'transaction', label: 'Transaction', properties: [] }, ctx)
  await ontology.defineEntityType({ name: 'document', label: 'Document', properties: [] }, ctx)

  await ontology.defineRelationshipType(
    { name: 'owned_by', from: 'account', to: 'transaction', cardinality: 'N..N', directed: true },
    ctx,
  )
  await ontology.defineRelationshipType(
    { name: 'proves', from: 'transaction', to: 'document', cardinality: 'N..1', directed: true },
    ctx,
  )
}

async function createInstance(
  ontology: ReturnType<typeof createOntology>,
  entityType: string,
  ctx: { tenantId: string },
  data: Record<string, unknown> = {},
): Promise<Instance> {
  return ontology.create(entityType, data, prov, ctx)
}

// ---------------------------------------------------------------------------
// AC-001: Forward traversal returns ordered nodes and edges along path
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / AC-001: forward traversal returns ordered nodes and edges', () => {
  it('AC-001 — forward traverse(["owned_by","proves"]) from A resolves with nodes [A,B,C] and 2 edges', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)
    const B = await createInstance(ontology, 'transaction', ctx)
    const C = await createInstance(ontology, 'document', ctx)

    await ontology.link('owned_by', A.id, B.id, prov, ctx)
    await ontology.link('proves', B.id, C.id, prov, ctx)

    const result = await ontology.traverse(
      { start: A.id, path: ['owned_by', 'proves'], direction: 'forward' },
      ctx,
    )

    expect(result).toBeDefined()
    expect(result.nodes).toHaveLength(3)
    expect(result.nodes[0]!.id).toBe(A.id)
    expect(result.nodes[1]!.id).toBe(B.id)
    expect(result.nodes[2]!.id).toBe(C.id)
    expect(result.edges).toHaveLength(2)
    expect(result.edges[0]!.relationship).toBe('owned_by')
    expect(result.edges[1]!.relationship).toBe('proves')
  })

  it('AC-001 — edges[0].fromId === A.id and edges[0].toId === B.id', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)
    const B = await createInstance(ontology, 'transaction', ctx)
    const C = await createInstance(ontology, 'document', ctx)

    await ontology.link('owned_by', A.id, B.id, prov, ctx)
    await ontology.link('proves', B.id, C.id, prov, ctx)

    const result = await ontology.traverse(
      { start: A.id, path: ['owned_by', 'proves'], direction: 'forward' },
      ctx,
    )

    expect(result.edges[0]!.fromId).toBe(A.id)
    expect(result.edges[0]!.toId).toBe(B.id)
    expect(result.edges[1]!.fromId).toBe(B.id)
    expect(result.edges[1]!.toId).toBe(C.id)
  })
})

// ---------------------------------------------------------------------------
// AC-002: Backward traversal reverses the path to trace to root
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / AC-002: backward traversal reverses path to trace root', () => {
  it('AC-002 — backward traverse(["proves","owned_by"]) from C resolves with nodes [C,B,A]', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)
    const B = await createInstance(ontology, 'transaction', ctx)
    const C = await createInstance(ontology, 'document', ctx)

    await ontology.link('owned_by', A.id, B.id, prov, ctx)
    await ontology.link('proves', B.id, C.id, prov, ctx)

    const result = await ontology.traverse(
      { start: C.id, path: ['proves', 'owned_by'], direction: 'backward' },
      ctx,
    )

    expect(result.nodes).toHaveLength(3)
    expect(result.nodes[0]!.id).toBe(C.id)
    expect(result.nodes[1]!.id).toBe(B.id)
    expect(result.nodes[2]!.id).toBe(A.id)
    expect(result.edges).toHaveLength(2)
  })

  it('AC-002 — backward edges are in reverse traversal order', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)
    const B = await createInstance(ontology, 'transaction', ctx)
    const C = await createInstance(ontology, 'document', ctx)

    await ontology.link('owned_by', A.id, B.id, prov, ctx)
    await ontology.link('proves', B.id, C.id, prov, ctx)

    const result = await ontology.traverse(
      { start: C.id, path: ['proves', 'owned_by'], direction: 'backward' },
      ctx,
    )

    // First backward edge: proves, toId=C → the edge connecting B→C
    expect(result.edges[0]!.relationship).toBe('proves')
    // Second backward edge: owned_by, toId=B → the edge connecting A→B
    expect(result.edges[1]!.relationship).toBe('owned_by')
  })
})

// ---------------------------------------------------------------------------
// FR-N01: traverse() signature — all required fields
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / FR-N01: traverse() is a public Layer-3 method with required fields', () => {
  it('FR-N01 — traverse resolves a TraversalResult promise on valid input', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)

    const result = await ontology.traverse(
      { start: A.id, path: [], direction: 'forward' },
      ctx,
    )

    expect(result).toBeDefined()
    expect(result.nodes).toBeDefined()
    expect(result.edges).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// FR-E05: start or path absent → reject immediately
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / FR-E05: REQUIRED_PROPERTY_MISSING when start or path is absent', () => {
  it('FR-E05 — missing start rejects with REQUIRED_PROPERTY_MISSING', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    await expectRejects(
      ontology.traverse({ start: undefined as never, path: ['owned_by'], direction: 'forward' }, ctx),
      'REQUIRED_PROPERTY_MISSING',
    )
  })

  it('FR-E05 — empty string start rejects with REQUIRED_PROPERTY_MISSING', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    await expectRejects(
      ontology.traverse({ start: '', path: ['owned_by'], direction: 'forward' }, ctx),
      'REQUIRED_PROPERTY_MISSING',
    )
  })

  it('FR-E05 — missing path rejects with REQUIRED_PROPERTY_MISSING', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)

    await expectRejects(
      ontology.traverse({ start: A.id, path: undefined as never, direction: 'forward' }, ctx),
      'REQUIRED_PROPERTY_MISSING',
    )
  })
})

// ---------------------------------------------------------------------------
// FR-E01: UNKNOWN_RELATIONSHIP_TYPE — path element not registered
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / FR-E01: UNKNOWN_RELATIONSHIP_TYPE when path element not registered', () => {
  it('FR-E01 — path with unknown relationship name rejects with UNKNOWN_RELATIONSHIP_TYPE', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)

    await expectRejects(
      ontology.traverse({ start: A.id, path: ['nonexistent_rel'], direction: 'forward' }, ctx),
      'UNKNOWN_RELATIONSHIP_TYPE',
    )
  })

  it('FR-E01 — path with mix of valid/invalid names rejects with UNKNOWN_RELATIONSHIP_TYPE', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)

    await expectRejects(
      ontology.traverse({ start: A.id, path: ['owned_by', 'ghost_rel'], direction: 'forward' }, ctx),
      'UNKNOWN_RELATIONSHIP_TYPE',
    )
  })

  it('FR-E01 — no traversal is performed when path element is unknown', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)
    const B = await createInstance(ontology, 'transaction', ctx)
    await ontology.link('owned_by', A.id, B.id, prov, ctx)

    let rejected = false
    try {
      await ontology.traverse({ start: A.id, path: ['nonexistent_rel'], direction: 'forward' }, ctx)
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// FR-E02: INSTANCE_NOT_FOUND — start does not exist
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / FR-E02: INSTANCE_NOT_FOUND when start instance does not exist', () => {
  it('FR-E02 — nonexistent start rejects with INSTANCE_NOT_FOUND', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    await expectRejects(
      ontology.traverse(
        { start: '00000000-0000-4000-8000-000000000000', path: ['owned_by'], direction: 'forward' },
        ctx,
      ),
      'INSTANCE_NOT_FOUND',
    )
  })
})

// ---------------------------------------------------------------------------
// FR-E03: INVALID_CONDITION_EXPR — where contains unknown op
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / FR-E03: INVALID_CONDITION_EXPR when where has unknown op', () => {
  it('FR-E03 — where with unknown op rejects with INVALID_CONDITION_EXPR before traversal', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)

    const badCondition = { op: 'foobar', value: 42 } as unknown as ConditionExpr

    await expectRejects(
      ontology.traverse({ start: A.id, path: [], direction: 'forward', where: badCondition }, ctx),
      'INVALID_CONDITION_EXPR',
    )
  })

  it('FR-E03 — call rejects before any traversal when where is invalid', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)
    const B = await createInstance(ontology, 'transaction', ctx)
    await ontology.link('owned_by', A.id, B.id, prov, ctx)

    const badCondition = { op: 'INVALID' } as unknown as ConditionExpr

    let rejected = false
    try {
      await ontology.traverse({ start: A.id, path: ['owned_by'], direction: 'forward', where: badCondition }, ctx)
    } catch {
      rejected = true
    }
    expect(rejected).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// FR-N02: start not found → reject (strict mode per spec)
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / FR-N02: start instance not found → reject', () => {
  it('FR-N02 — traverse with nonexistent start id rejects', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    await expectRejects(
      ontology.traverse(
        { start: '00000000-0000-4000-8000-000000000001', path: [], direction: 'forward' },
        ctx,
      ),
      'INSTANCE_NOT_FOUND',
    )
  })
})

// ---------------------------------------------------------------------------
// FR-N03: each path element must be a registered RelationshipType
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / FR-N03: path elements must be registered RelationshipType names', () => {
  it('FR-N03 — all registered elements succeed; first unregistered rejects', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)

    // valid path
    const result = await ontology.traverse(
      { start: A.id, path: ['owned_by'], direction: 'forward' },
      ctx,
    )
    expect(result.nodes[0]!.id).toBe(A.id)

    // invalid path element
    await expectRejects(
      ontology.traverse({ start: A.id, path: ['no_such_rel'], direction: 'forward' }, ctx),
      'UNKNOWN_RELATIONSHIP_TYPE',
    )
  })
})

// ---------------------------------------------------------------------------
// FR-N04: forward uses fromId, backward uses toId
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / FR-N04: forward uses fromId edge direction; backward uses toId', () => {
  it('FR-N04 — forward traverse follows fromId → toId chain', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)
    const B = await createInstance(ontology, 'transaction', ctx)
    await ontology.link('owned_by', A.id, B.id, prov, ctx)

    const result = await ontology.traverse(
      { start: A.id, path: ['owned_by'], direction: 'forward' },
      ctx,
    )

    expect(result.nodes).toHaveLength(2)
    expect(result.nodes[0]!.id).toBe(A.id)
    expect(result.nodes[1]!.id).toBe(B.id)
  })

  it('FR-N04 — backward traverse follows toId → fromId chain (truy_nguoc)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)
    const B = await createInstance(ontology, 'transaction', ctx)
    await ontology.link('owned_by', A.id, B.id, prov, ctx)

    const result = await ontology.traverse(
      { start: B.id, path: ['owned_by'], direction: 'backward' },
      ctx,
    )

    expect(result.nodes).toHaveLength(2)
    expect(result.nodes[0]!.id).toBe(B.id)
    expect(result.nodes[1]!.id).toBe(A.id)
  })
})

// ---------------------------------------------------------------------------
// FR-N05: where condition filters nodes visited during traversal
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / FR-N05: where condition filters nodes during traversal', () => {
  it('FR-N05 — node not satisfying where causes traversal to stop at that node (excluded from nodes)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)
    const B = await createInstance(ontology, 'transaction', ctx)  // no amount
    const C = await createInstance(ontology, 'document', ctx)

    await ontology.link('owned_by', A.id, B.id, prov, ctx)
    await ontology.link('proves', B.id, C.id, prov, ctx)

    // where requires amount=100, but B has no amount → B is excluded
    const whereCondition: ConditionExpr = {
      op: 'compare',
      left: { kind: 'property', entity: 'transaction', name: 'amount' },
      cmp: '=',
      right: { kind: 'literal', value: 100 },
    }

    const result = await ontology.traverse(
      { start: A.id, path: ['owned_by', 'proves'], direction: 'forward', where: whereCondition },
      ctx,
    )

    // B doesn't satisfy where, so traversal stops — only A (start) in nodes
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]!.id).toBe(A.id)
    expect(result.edges).toHaveLength(0)
  })

  it('FR-N05 — node satisfying where is included; traversal continues', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    // Custom entity type with an amount property
    const adapter = new InMemoryAdapter()
    const ont = createOntology({ adapter })
    await ont.defineEntityType({ name: 'account', label: 'Account', properties: [] }, ctx)
    await ont.defineEntityType({
      name: 'transaction',
      label: 'Transaction',
      properties: [{ name: 'amount', type: 'number' }],
    }, ctx)
    await ont.defineEntityType({ name: 'document', label: 'Document', properties: [] }, ctx)
    await ont.defineRelationshipType(
      { name: 'owned_by', from: 'account', to: 'transaction', cardinality: 'N..N', directed: true },
      ctx,
    )
    await ont.defineRelationshipType(
      { name: 'proves', from: 'transaction', to: 'document', cardinality: 'N..1', directed: true },
      ctx,
    )

    const A = await ont.create('account', {}, prov, ctx)
    const B = await ont.create('transaction', { amount: 100 }, prov, ctx)
    const C = await ont.create('document', {}, prov, ctx)

    await ont.link('owned_by', A.id, B.id, prov, ctx)
    await ont.link('proves', B.id, C.id, prov, ctx)

    const whereCondition: ConditionExpr = {
      op: 'compare',
      left: { kind: 'property', entity: 'transaction', name: 'amount' },
      cmp: '=',
      right: { kind: 'literal', value: 100 },
    }

    const result = await ont.traverse(
      { start: A.id, path: ['owned_by', 'proves'], direction: 'forward', where: whereCondition },
      ctx,
    )

    // B satisfies where (amount=100), so included, and C is reached
    expect(result.nodes.length).toBeGreaterThanOrEqual(2)
    const ids = result.nodes.map((n) => n.id)
    expect(ids).toContain(A.id)
    expect(ids).toContain(B.id)
  })
})

// ---------------------------------------------------------------------------
// FR-N06: adapter.traverse? is used when available
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / FR-N06: adapter.traverse? is used when available', () => {
  it('FR-N06 — default planner is used when adapter.traverse is not implemented (InMemoryAdapter)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)
    const B = await createInstance(ontology, 'transaction', ctx)
    await ontology.link('owned_by', A.id, B.id, prov, ctx)

    // InMemoryAdapter does not implement traverse? → default planner is used
    const result = await ontology.traverse(
      { start: A.id, path: ['owned_by'], direction: 'forward' },
      ctx,
    )
    expect(result.nodes).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// FR-N07: default recursive planner executes one queryEdges per path step
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / FR-N07: default planner executes step-by-step via queryEdges', () => {
  it('FR-N07 — 3-step path produces correct nodes and edges in order', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    // Set up 4-node chain: A→B→C→D
    await ontology.defineEntityType({ name: 'node', label: 'Node', properties: [] }, ctx)
    await ontology.defineRelationshipType(
      { name: 'step', from: 'node', to: 'node', cardinality: 'N..N', directed: true },
      ctx,
    )

    const [A, B, C, D] = await Promise.all([
      createInstance(ontology, 'node', ctx),
      createInstance(ontology, 'node', ctx),
      createInstance(ontology, 'node', ctx),
      createInstance(ontology, 'node', ctx),
    ])

    await ontology.link('step', A!.id, B!.id, prov, ctx)
    await ontology.link('step', B!.id, C!.id, prov, ctx)
    await ontology.link('step', C!.id, D!.id, prov, ctx)

    const result = await ontology.traverse(
      { start: A!.id, path: ['step', 'step', 'step'], direction: 'forward' },
      ctx,
    )

    expect(result.nodes).toHaveLength(4)
    expect(result.nodes[0]!.id).toBe(A!.id)
    expect(result.nodes[1]!.id).toBe(B!.id)
    expect(result.nodes[2]!.id).toBe(C!.id)
    expect(result.nodes[3]!.id).toBe(D!.id)
    expect(result.edges).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// FR-N08: TraversalResult.nodes[0] is always the start instance
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / FR-N08: nodes[0] is always the start instance', () => {
  it('FR-N08 — nodes[0] is the start instance even with no edges traversed', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)

    const result = await ontology.traverse(
      { start: A.id, path: [], direction: 'forward' },
      ctx,
    )

    expect(result.nodes[0]!.id).toBe(A.id)
  })

  it('FR-N08 — nodes[0] is the start instance in a multi-hop traversal', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)
    const B = await createInstance(ontology, 'transaction', ctx)
    const C = await createInstance(ontology, 'document', ctx)

    await ontology.link('owned_by', A.id, B.id, prov, ctx)
    await ontology.link('proves', B.id, C.id, prov, ctx)

    const result = await ontology.traverse(
      { start: A.id, path: ['owned_by', 'proves'], direction: 'forward' },
      ctx,
    )

    expect(result.nodes[0]!.id).toBe(A.id)
  })
})

// ---------------------------------------------------------------------------
// FR-N09: traversal terminates gracefully when no edges at a step
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / FR-N09: graceful termination when no edges exist at a step', () => {
  it('FR-N09 — partial path traversed without error when edges run out', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)
    const B = await createInstance(ontology, 'transaction', ctx)
    await ontology.link('owned_by', A.id, B.id, prov, ctx)
    // No 'proves' edge from B — traversal stops after owned_by

    const result = await ontology.traverse(
      { start: A.id, path: ['owned_by', 'proves'], direction: 'forward' },
      ctx,
    )

    // Nodes up to the point edges ran out
    expect(result.nodes).toHaveLength(2) // A and B
    expect(result.nodes[0]!.id).toBe(A.id)
    expect(result.nodes[1]!.id).toBe(B.id)
    expect(result.edges).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// FR-N10: All traversal is tenant-scoped
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / FR-N10: traversal is tenant-scoped', () => {
  it('FR-N10 — edges from tenant-alpha are not visible during traversal for tenant-beta', async () => {
    const { ontology } = makeOntology()
    const ctxAlpha = { tenantId: 'tenant-alpha' }
    const ctxBeta = { tenantId: 'tenant-beta' }

    await setupSchema(ontology, ctxAlpha)
    await setupSchema(ontology, ctxBeta)

    const A = await createInstance(ontology, 'account', ctxAlpha)
    const B = await createInstance(ontology, 'transaction', ctxAlpha)
    await ontology.link('owned_by', A.id, B.id, prov, ctxAlpha)

    // Create a separate start node in beta
    const betaA = await createInstance(ontology, 'account', ctxBeta)

    // betaA has no edges in beta, traversal stays at betaA
    const result = await ontology.traverse(
      { start: betaA.id, path: ['owned_by'], direction: 'forward' },
      ctxBeta,
    )

    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]!.id).toBe(betaA.id)
  })

  it('FR-N10 — traverse with start from another tenant rejects with INSTANCE_NOT_FOUND', async () => {
    const { ontology } = makeOntology()
    const ctxAlpha = { tenantId: 'tenant-alpha' }
    const ctxBeta = { tenantId: 'tenant-beta' }

    await setupSchema(ontology, ctxAlpha)
    await setupSchema(ontology, ctxBeta)

    const A = await createInstance(ontology, 'account', ctxAlpha)

    // Using alpha's instance id in beta's context
    await expectRejects(
      ontology.traverse({ start: A.id, path: ['owned_by'], direction: 'forward' }, ctxBeta),
      'INSTANCE_NOT_FOUND',
    )
  })
})

// ---------------------------------------------------------------------------
// FR-X01: empty path → nodes=[start], edges=[]
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / FR-X01: empty path returns only start node', () => {
  it('FR-X01 — path:[] resolves with nodes=[startInstance] and edges=[]', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)

    const result = await ontology.traverse(
      { start: A.id, path: [], direction: 'forward' },
      ctx,
    )

    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]!.id).toBe(A.id)
    expect(result.edges).toHaveLength(0)
  })

  it('FR-X01 — empty path backward also returns only start node', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)

    const result = await ontology.traverse(
      { start: A.id, path: [], direction: 'backward' },
      ctx,
    )

    expect(result.nodes).toHaveLength(1)
    expect(result.edges).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// FR-X02: single-step path with no edges → nodes=[start], edges=[]
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / FR-X02: single-step path with no edges returns start node only', () => {
  it('FR-X02 — forward path ["owned_by"] with no outgoing edges → nodes=[start], edges=[]', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx) // isolated, no edges

    const result = await ontology.traverse(
      { start: A.id, path: ['owned_by'], direction: 'forward' },
      ctx,
    )

    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]!.id).toBe(A.id)
    expect(result.edges).toHaveLength(0)
  })

  it('FR-X02 — backward path with no incoming edges → nodes=[start], edges=[]', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const B = await createInstance(ontology, 'transaction', ctx) // isolated

    const result = await ontology.traverse(
      { start: B.id, path: ['owned_by'], direction: 'backward' },
      ctx,
    )

    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]!.id).toBe(B.id)
    expect(result.edges).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// FR-X03: cyclic path traversed step-by-step (no cycle detection in v1)
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / FR-X03: cyclic path traversed step-by-step without cycle detection', () => {
  it('FR-X03 — path with repeated relationship type traverses step by step', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await ontology.defineEntityType({ name: 'node', label: 'Node', properties: [] }, ctx)
    await ontology.defineRelationshipType(
      { name: 'links', from: 'node', to: 'node', cardinality: 'N..N', directed: true },
      ctx,
    )

    const X = await createInstance(ontology, 'node', ctx)
    const Y = await createInstance(ontology, 'node', ctx)

    await ontology.link('links', X.id, Y.id, prov, ctx)
    await ontology.link('links', Y.id, X.id, prov, ctx) // creates cycle

    // path ["links","links","links"] traverses 3 steps (may revisit nodes)
    const result = await ontology.traverse(
      { start: X.id, path: ['links', 'links', 'links'], direction: 'forward' },
      ctx,
    )

    // Traversal should not error; nodes length depends on frontier expansion
    expect(result).toBeDefined()
    expect(result.nodes.length).toBeGreaterThanOrEqual(1)
    expect(result.edges).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// FR-X04: path of length 10 is valid; executes 10 queryEdges calls
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / FR-X04: path of length 10 is valid', () => {
  it('FR-X04 — 10-step path executes without error', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await ontology.defineEntityType({ name: 'node', label: 'Node', properties: [] }, ctx)
    await ontology.defineRelationshipType(
      { name: 'hop', from: 'node', to: 'node', cardinality: 'N..N', directed: true },
      ctx,
    )

    const start = await createInstance(ontology, 'node', ctx)
    const path = Array(10).fill('hop')

    // No edges, but should not error
    const result = await ontology.traverse({ start: start.id, path, direction: 'forward' }, ctx)

    expect(result.nodes).toHaveLength(1) // just start, no edges
    expect(result.edges).toHaveLength(0)
  })

  // BDD: BR-015/edge — path of length 10 with actual 10-instance chain → nodes.length=11, edges.length=10
  // DQA:rule=BR-015 DQA:path=edge DQA:verifies=S006-FR-X04,S006-FR-N07
  it('FR-X04 — 10-instance chain traversed with path length 10 resolves nodes.length=11 edges.length=10', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await ontology.defineEntityType({ name: 'node', label: 'Node', properties: [] }, ctx)
    await ontology.defineRelationshipType(
      { name: 'owned_by', from: 'node', to: 'node', cardinality: 'N..N', directed: true },
      ctx,
    )

    // Build a chain of 11 instances connected by 10 'owned_by' edges
    const chain: Instance[] = []
    for (let i = 0; i < 11; i++) {
      chain.push(await createInstance(ontology, 'node', ctx))
    }
    for (let i = 0; i < 10; i++) {
      await ontology.link('owned_by', chain[i]!.id, chain[i + 1]!.id, prov, ctx)
    }

    const path = Array(10).fill('owned_by')
    const result = await ontology.traverse({ start: chain[0]!.id, path, direction: 'forward' }, ctx)

    expect(result.nodes).toHaveLength(11)
    expect(result.edges).toHaveLength(10)
    expect(result.nodes[0]!.id).toBe(chain[0]!.id)
    expect(result.nodes[10]!.id).toBe(chain[10]!.id)
  })
})

// ---------------------------------------------------------------------------
// FR-X05: backward + directed:false → follows both endpoint directions
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / FR-X05: backward + directed:false relationship follows both endpoint directions', () => {
  it('FR-X05 — undirected relationship follows edges in both endpoint directions for backward traversal', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await ontology.defineEntityType({ name: 'node', label: 'Node', properties: [] }, ctx)
    await ontology.defineRelationshipType(
      { name: 'connected', from: 'node', to: 'node', cardinality: 'N..N', directed: false },
      ctx,
    )

    const X = await createInstance(ontology, 'node', ctx)
    const Y = await createInstance(ontology, 'node', ctx)
    const Z = await createInstance(ontology, 'node', ctx)

    // X is "from" side: X→Y, Z→X (X is "to" side for Z)
    await ontology.link('connected', X.id, Y.id, prov, ctx)
    await ontology.link('connected', Z.id, X.id, prov, ctx)

    // backward traverse from Y should find X (via the X→Y edge, toId=Y)
    const result = await ontology.traverse(
      { start: Y.id, path: ['connected'], direction: 'backward' },
      ctx,
    )

    const ids = result.nodes.map((n) => n.id)
    expect(ids).toContain(Y.id)
    expect(ids).toContain(X.id)
  })
})

// ---------------------------------------------------------------------------
// FR-D01: TraversalResult shape — nodes, edges with correct lengths
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / FR-D01: TraversalResult.edges.length === nodes.length - 1 for linear path', () => {
  it('FR-D01 — 1-hop traversal: 2 nodes, 1 edge', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)
    const B = await createInstance(ontology, 'transaction', ctx)
    await ontology.link('owned_by', A.id, B.id, prov, ctx)

    const result = await ontology.traverse(
      { start: A.id, path: ['owned_by'], direction: 'forward' },
      ctx,
    )

    expect(result.nodes).toHaveLength(2)
    expect(result.edges).toHaveLength(1)
    expect(result.edges.length).toBe(result.nodes.length - 1)
  })

  it('FR-D01 — 2-hop traversal: 3 nodes, 2 edges', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)
    const B = await createInstance(ontology, 'transaction', ctx)
    const C = await createInstance(ontology, 'document', ctx)
    await ontology.link('owned_by', A.id, B.id, prov, ctx)
    await ontology.link('proves', B.id, C.id, prov, ctx)

    const result = await ontology.traverse(
      { start: A.id, path: ['owned_by', 'proves'], direction: 'forward' },
      ctx,
    )

    expect(result.nodes).toHaveLength(3)
    expect(result.edges).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// FR-D02: TraverseSpec shape — plain value object
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / FR-D02: TraverseSpec is a plain value object (no methods)', () => {
  it('FR-D02 — TraverseSpec with all fields accepted and produces result', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)

    const spec: { start: string; path: string[]; direction: 'forward' | 'backward' } = {
      start: A.id,
      path: ['owned_by'],
      direction: 'forward' as const,
    }

    const result = await ontology.traverse(spec, ctx)
    expect(result).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// FR-D03: Edge objects in TraversalResult carry full provenance
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / FR-D03: edges in TraversalResult carry full Edge objects with provenance', () => {
  it('FR-D03 — each edge in result has id, relationship, fromId, toId, provenance', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)
    const B = await createInstance(ontology, 'transaction', ctx)
    await ontology.link('owned_by', A.id, B.id, prov, ctx)

    const result = await ontology.traverse(
      { start: A.id, path: ['owned_by'], direction: 'forward' },
      ctx,
    )

    expect(result.edges).toHaveLength(1)
    const edge = result.edges[0]!
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
// FR-D04: TraversalResult is serializable to JSON without special handling
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / FR-D04: TraversalResult is JSON-serializable', () => {
  it('FR-D04 — JSON.stringify/parse produces identical nodes and edges', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)
    const B = await createInstance(ontology, 'transaction', ctx)
    await ontology.link('owned_by', A.id, B.id, prov, ctx)

    const result = await ontology.traverse(
      { start: A.id, path: ['owned_by'], direction: 'forward' },
      ctx,
    )

    const serialized = JSON.stringify(result)
    const parsed: TraversalResult = JSON.parse(serialized)

    expect(parsed.nodes).toHaveLength(result.nodes.length)
    expect(parsed.edges).toHaveLength(result.edges.length)
    expect(parsed.nodes[0]!.id).toBe(A.id)
    expect(parsed.nodes[1]!.id).toBe(B.id)
  })
})

// ---------------------------------------------------------------------------
// NFR-P01: performance — 4-hop traverse with 500 instances within 200ms
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / NFR-P01: performance — traverse with path of length 4 completes within 200ms', () => {
  it('NFR-P01 — 4-hop linear path through 500-instance graph completes within 200ms', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'perf-tenant' }
    await ontology.defineEntityType({ name: 'node', label: 'Node', properties: [] }, ctx)
    await ontology.defineRelationshipType(
      { name: 'hop', from: 'node', to: 'node', cardinality: 'N..N', directed: true },
      ctx,
    )

    // Create 500 instances (to satisfy the NFR spec condition)
    const nodes: Instance[] = []
    for (let i = 0; i < 500; i++) {
      nodes.push(await createInstance(ontology, 'node', ctx))
    }

    // Create a linear 4-hop chain from nodes[0]→[1]→[2]→[3]→[4]
    await ontology.link('hop', nodes[0]!.id, nodes[1]!.id, prov, ctx)
    await ontology.link('hop', nodes[1]!.id, nodes[2]!.id, prov, ctx)
    await ontology.link('hop', nodes[2]!.id, nodes[3]!.id, prov, ctx)
    await ontology.link('hop', nodes[3]!.id, nodes[4]!.id, prov, ctx)

    const start = Date.now()
    const result = await ontology.traverse(
      { start: nodes[0]!.id, path: ['hop', 'hop', 'hop', 'hop'], direction: 'forward' },
      ctx,
    )
    const elapsed = Date.now() - start

    expect(result.nodes).toHaveLength(5)
    expect(elapsed).toBeLessThan(200)
  })
})

// ---------------------------------------------------------------------------
// NFR-S01: security — condition validated before traversal; cross-tenant denial
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / NFR-S01: security — where validated before traversal; cross-tenant denial', () => {
  it('NFR-S01 — only allowed op values pass condition validation', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'secure-tenant' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)

    // Valid ops: and/or/not/compare/exists/absent/count — but exists/absent/count
    // would be caught as UNSUPPORTED_OP during property matching. Let's verify
    // that an entirely unknown op is caught as INVALID_CONDITION_EXPR.
    const invalidOps = [
      { op: 'inject', value: "'; DROP TABLE instances; --" },
      { op: 'eval', code: 'process.exit()' },
      { op: 'exec', command: 'rm -rf /' },
    ] as unknown as ConditionExpr[]

    for (const badCondition of invalidOps) {
      await expectRejects(
        ontology.traverse({ start: A.id, path: [], direction: 'forward', where: badCondition }, ctx),
        'INVALID_CONDITION_EXPR',
      )
    }
  })

  it('NFR-S01 — cross-tenant traversal is structurally denied (start id not in scope)', async () => {
    const { ontology } = makeOntology()
    const ctxAlpha = { tenantId: 'tenant-alpha' }
    const ctxBeta = { tenantId: 'tenant-beta' }

    await setupSchema(ontology, ctxAlpha)
    await setupSchema(ontology, ctxBeta)

    const A = await createInstance(ontology, 'account', ctxAlpha)

    await expectRejects(
      ontology.traverse({ start: A.id, path: [], direction: 'forward' }, ctxBeta),
      'INSTANCE_NOT_FOUND',
    )
  })

  it('NFR-S01 — path elements are treated as opaque strings resolved against schema registry only', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'secure-tenant' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)

    // A domain-looking relationship name that is not registered → UNKNOWN_RELATIONSHIP_TYPE
    await expectRejects(
      ontology.traverse({ start: A.id, path: ['chung_minh'], direction: 'forward' }, ctx),
      'UNKNOWN_RELATIONSHIP_TYPE',
    )
  })
})

// ---------------------------------------------------------------------------
// TENANT_MISMATCH: empty tenantId
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / TENANT_MISMATCH: empty tenantId rejects with TENANT_MISMATCH', () => {
  it('traverse() with empty tenantId rejects with TENANT_MISMATCH', async () => {
    const { ontology } = makeOntology()
    const ctxEmpty = { tenantId: '' }

    await expectRejects(
      ontology.traverse({ start: 'some-id', path: [], direction: 'forward' }, ctxEmpty),
      'TENANT_MISMATCH',
    )
  })
})

// ---------------------------------------------------------------------------
// TraversalCompleted event: idempotency
// BDD: DQA:event=TraversalCompleted DQA:path=idempotency
// DQA:verifies=S006-FR-N01,S006-FR-N08,S006-FR-D01
// Scenario: calling traverse() twice with the same params produces identical results
// and does not mutate any state (traverse is a read operation).
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / TraversalCompleted event idempotency: two calls produce identical results', () => {
  it('idempotency — two traverse() calls with same params resolve with identical TraversalResult content', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)
    const B = await createInstance(ontology, 'transaction', ctx)
    const C = await createInstance(ontology, 'document', ctx)

    await ontology.link('owned_by', A.id, B.id, prov, ctx)
    await ontology.link('proves', B.id, C.id, prov, ctx)

    const spec = { start: A.id, path: ['owned_by', 'proves'], direction: 'forward' as const }

    const result1 = await ontology.traverse(spec, ctx)
    const result2 = await ontology.traverse(spec, ctx)

    // Both calls resolve with identical node order and edge relationships
    expect(result1.nodes).toHaveLength(3)
    expect(result2.nodes).toHaveLength(3)
    expect(result1.nodes.map((n) => n.id)).toEqual(result2.nodes.map((n) => n.id))
    expect(result1.edges.map((e) => e.relationship)).toEqual(result2.edges.map((e) => e.relationship))
    expect(result1.edges.map((e) => e.id)).toEqual(result2.edges.map((e) => e.id))
  })

  it('idempotency — traverse() does not mutate instance or edge state', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const A = await createInstance(ontology, 'account', ctx)
    const B = await createInstance(ontology, 'transaction', ctx)
    await ontology.link('owned_by', A.id, B.id, prov, ctx)

    await ontology.traverse({ start: A.id, path: ['owned_by'], direction: 'forward' }, ctx)
    await ontology.traverse({ start: A.id, path: ['owned_by'], direction: 'forward' }, ctx)

    // After two traversals, the graph is unchanged — still exactly 1 neighbor
    const neighbors = await ontology.neighbors(A.id, 'owned_by', ctx)
    expect(neighbors).toHaveLength(1)
    expect(neighbors[0]!.id).toBe(B.id)
  })
})

// ---------------------------------------------------------------------------
// TraversalCompleted event: concurrency
// BDD: DQA:event=TraversalCompleted DQA:path=concurrency
// DQA:verifies=S006-FR-N10,S006-NFR-P01
// Scenario: two concurrent traverse() calls from different starting nodes resolve independently
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / TraversalCompleted event concurrency: two concurrent traversals resolve independently', () => {
  it('concurrency — two concurrent traverse() from different start nodes both resolve correctly', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    // Build: acct-A → txn-B and acct-Z → txn-B (both owned_by to same txn-B)
    const acctA = await createInstance(ontology, 'account', ctx)
    const acctZ = await createInstance(ontology, 'account', ctx)
    const txnB = await createInstance(ontology, 'transaction', ctx)

    await ontology.link('owned_by', acctA.id, txnB.id, prov, ctx)
    await ontology.link('owned_by', acctZ.id, txnB.id, prov, ctx)

    // Both concurrent calls
    const [resultA, resultZ] = await Promise.all([
      ontology.traverse({ start: acctA.id, path: ['owned_by'], direction: 'forward' }, ctx),
      ontology.traverse({ start: acctZ.id, path: ['owned_by'], direction: 'forward' }, ctx),
    ])

    // Both resolve without error
    expect(resultA.nodes).toHaveLength(2)
    expect(resultA.nodes[0]!.id).toBe(acctA.id)
    expect(resultA.nodes[1]!.id).toBe(txnB.id)

    expect(resultZ.nodes).toHaveLength(2)
    expect(resultZ.nodes[0]!.id).toBe(acctZ.id)
    expect(resultZ.nodes[1]!.id).toBe(txnB.id)
  })

  it('concurrency — results from concurrent traversals are independent (different start, shared txn-B)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-alpha' }
    await setupSchema(ontology, ctx)

    const acctA = await createInstance(ontology, 'account', ctx)
    const acctZ = await createInstance(ontology, 'account', ctx)
    const txnB = await createInstance(ontology, 'transaction', ctx)

    await ontology.link('owned_by', acctA.id, txnB.id, prov, ctx)
    await ontology.link('owned_by', acctZ.id, txnB.id, prov, ctx)

    const [resultA, resultZ] = await Promise.all([
      ontology.traverse({ start: acctA.id, path: ['owned_by'], direction: 'forward' }, ctx),
      ontology.traverse({ start: acctZ.id, path: ['owned_by'], direction: 'forward' }, ctx),
    ])

    // Both results contain txn-B as the traversed node
    const idsA = resultA.nodes.map((n) => n.id)
    const idsZ = resultZ.nodes.map((n) => n.id)
    expect(idsA).toContain(txnB.id)
    expect(idsZ).toContain(txnB.id)

    // Start nodes are independent
    expect(idsA[0]).toBe(acctA.id)
    expect(idsZ[0]).toBe(acctZ.id)
  })
})

// ---------------------------------------------------------------------------
// GAP-N04 resolution: FR-E04 — UNSUPPORTED_OP propagates from traverse()
// ---------------------------------------------------------------------------

describe('BDD STORY-006 / FR-E04: UNSUPPORTED_OP propagates when where condition uses relationship op', () => {
  it('traverse() with a where condition using "exists" op throws UNSUPPORTED_OP (FR-E04)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-e04' }
    await setupSchema(ontology, ctx)

    const acct = await createInstance(ontology, 'account', ctx)
    const txn = await createInstance(ontology, 'transaction', ctx)
    await ontology.link('owned_by', acct.id, txn.id, prov, ctx)

    // "exists" is a structurally valid ConditionExpr op (passes validateCondition),
    // but the default planner calls matchesProperties which throws UNSUPPORTED_OP
    // when it encounters a relationship-level op (FR-E04 path).
    const where: ConditionExpr = { op: 'exists', relationship: 'owned_by' }

    let caught: unknown
    try {
      await ontology.traverse({ start: acct.id, path: ['owned_by'], direction: 'forward', where }, ctx)
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(OntologyError)
    expect((caught as OntologyError).code).toBe('UNSUPPORTED_OP')
  })
})

// ---------------------------------------------------------------------------
// SEC-OTHER-05/06/07: DoS guards — maxDepth, cycle detection, maxNodes
// ---------------------------------------------------------------------------

describe('SEC-OTHER-05: traverse() rejects path longer than MAX_PATH_DEPTH (20)', () => {
  it('path with 21 hops throws TRAVERSAL_LIMIT_EXCEEDED', async () => {
    const adapter = new InMemoryAdapter()
    const ontology = createOntology({ adapter })
    const ctx = { tenantId: 'tenant-sec' }
    const prov: Provenance = { source_ref: 'sec', confirmed_by: 'tester', confirmed_at: '2026-01-01T00:00:00Z' }

    await ontology.defineEntityType({ name: 'Node', label: 'Node', properties: [] }, ctx)
    await ontology.defineRelationshipType({ name: 'links', from: 'Node', to: 'Node', cardinality: 'N..N', directed: true }, ctx)
    await ontology.migrate(ctx)
    const a = await ontology.create('Node', {}, prov, ctx)

    let caught: unknown
    try {
      await ontology.traverse({ start: a.id, path: new Array(21).fill('links'), direction: 'forward' }, ctx)
    } catch (err) { caught = err }

    expect(caught).toBeInstanceOf(OntologyError)
    expect((caught as OntologyError).code).toBe('TRAVERSAL_LIMIT_EXCEEDED')
  })

  it('path with exactly 20 hops is accepted (boundary)', async () => {
    const adapter = new InMemoryAdapter()
    const ontology = createOntology({ adapter })
    const ctx = { tenantId: 'tenant-sec2' }
    const prov: Provenance = { source_ref: 'sec', confirmed_by: 'tester', confirmed_at: '2026-01-01T00:00:00Z' }

    await ontology.defineEntityType({ name: 'Node', label: 'Node', properties: [] }, ctx)
    await ontology.defineRelationshipType({ name: 'links', from: 'Node', to: 'Node', cardinality: 'N..N', directed: true }, ctx)
    await ontology.migrate(ctx)
    const a = await ontology.create('Node', {}, prov, ctx)

    // 20 hops with no edges → terminates gracefully (FR-N09), no error
    const result = await ontology.traverse({ start: a.id, path: new Array(20).fill('links'), direction: 'forward' }, ctx)
    expect(result.nodes).toHaveLength(1)
    expect(result.nodes[0]!.id).toBe(a.id)
  })
})

describe('SEC-OTHER-06: traverse() terminates cleanly on a cyclic graph (A→B→A)', () => {
  it('cyclic graph does not produce infinite loop — returns reachable nodes then stops', async () => {
    const adapter = new InMemoryAdapter()
    const ontology = createOntology({ adapter })
    const ctx = { tenantId: 'tenant-cycle' }
    const prov: Provenance = { source_ref: 'sec', confirmed_by: 'tester', confirmed_at: '2026-01-01T00:00:00Z' }

    await ontology.defineEntityType({ name: 'Node', label: 'Node', properties: [] }, ctx)
    await ontology.defineRelationshipType({ name: 'links', from: 'Node', to: 'Node', cardinality: 'N..N', directed: true }, ctx)
    await ontology.migrate(ctx)

    const a = await ontology.create('Node', {}, prov, ctx)
    const b = await ontology.create('Node', {}, prov, ctx)
    await ontology.link('links', a.id, b.id, prov, ctx)
    await ontology.link('links', b.id, a.id, prov, ctx)  // creates cycle A→B→A

    // With a 10-hop path over a cycle: without the fix this loops forever;
    // with the fix, B is visited at step 1, then step 2 finds A is already visited → break
    const result = await ontology.traverse({ start: a.id, path: new Array(10).fill('links'), direction: 'forward' }, ctx)

    // Should return exactly [A, B] — not an infinite set, no error
    expect(result.nodes.length).toBe(2)
    expect(result.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id].sort())
  })
})
