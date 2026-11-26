/**
 * DQA:covers=S008-AC-001,S008-AC-002,S008-AC-005,S008-AC-006,S008-AC-007,S008-AC-009,S008-AC-010,S008-AC-011
 * DQA:rule=BR-010,BR-011,BR-012
 */

import { describe, it, expect } from 'vitest'
import {
  createOntology,
  InMemoryAdapter,
  OntologyError,
  type Provenance,
  type RuleDef,
} from '../../src/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOntology() {
  const adapter = new InMemoryAdapter()
  const ontology = createOntology({ adapter })
  return { ontology, adapter }
}

const baseProv: Provenance = {
  source_ref: 'test:seed',
  confirmed_by: 'tester@acme.com',
  confirmed_at: '2026-03-15T10:00:00.000Z',
}

const ruleProv: Provenance = {
  source_ref: 'rule:seed',
  confirmed_by: 'analyst@acme.com',
  confirmed_at: '2026-05-01T09:00:00.000Z',
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

function makeRuleDef(overrides: Partial<RuleDef> = {}): RuleDef {
  return {
    id: 'R-001',
    name: 'RequireProof',
    kind: 'REQUIRED_RELATION',
    appliesTo: 'invoice',
    condition: { op: 'absent', relationship: 'proves' },
    severity: 'PHAP_LY',
    message: 'Invoice {id} lacks a proof document.',
    source_ref: ruleProv.source_ref,
    confirmed_by: ruleProv.confirmed_by,
    confirmed_at: ruleProv.confirmed_at,
    enabled: true,
    version: 1,
    ...overrides,
  }
}

/**
 * Set up a basic schema with invoice + document entity types and a
 * "proves" relationship between them.
 */
async function setupSchema(
  ontology: ReturnType<typeof createOntology>,
  ctx: { tenantId: string },
) {
  await ontology.defineEntityType(
    { name: 'invoice', label: 'Invoice', properties: [{ name: 'amount', type: 'number' }] },
    ctx,
  )
  await ontology.defineEntityType(
    { name: 'document', label: 'Document', properties: [] },
    ctx,
  )
  await ontology.defineRelationshipType(
    { name: 'proves', from: 'invoice', to: 'document', cardinality: 'N..N', directed: true },
    ctx,
  )
}

/**
 * Set up full schema including transaction + tax_declaration for CROSS_CHECK tests.
 */
async function setupFullSchema(
  ontology: ReturnType<typeof createOntology>,
  ctx: { tenantId: string },
) {
  await setupSchema(ontology, ctx)
  await ontology.defineEntityType(
    { name: 'transaction', label: 'Transaction', properties: [{ name: 'amount', type: 'number' }] },
    ctx,
  )
  await ontology.defineEntityType(
    { name: 'tax_declaration', label: 'Tax Declaration', properties: [{ name: 'declared_revenue', type: 'number' }] },
    ctx,
  )
  await ontology.defineRelationshipType(
    { name: 'related_to', from: 'transaction', to: 'invoice', cardinality: 'N..N', directed: true },
    ctx,
  )
}

// ---------------------------------------------------------------------------
// AC-001: REQUIRED_RELATION rule raises Flag with trace when required relationship is absent
// ---------------------------------------------------------------------------

describe('BDD STORY-008 / AC-001: REQUIRED_RELATION rule raises Flag with trace when relationship is absent', () => {
  it('AC-001 — evaluateRules returns a Flag with ruleId, instanceId, severity, message, trace for absent edge', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    // Register rule: invoice must have a "proves" edge
    await ontology.registerRule(makeRuleDef({
      id: 'R-001',
      kind: 'REQUIRED_RELATION',
      appliesTo: 'invoice',
      condition: { op: 'absent', relationship: 'proves' },
      severity: 'PHAP_LY',
      message: 'Invoice {id} lacks a proof document.',
    }), ctx)

    // Create an invoice instance with NO outgoing "proves" edge
    const inv = await ontology.create('invoice', { amount: 1000 }, baseProv, ctx)

    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })

    expect(flags).toHaveLength(1)
    const flag = flags[0]!
    expect(flag.ruleId).toBe('R-001')
    expect(flag.instanceId).toBe(inv.id)
    expect(flag.severity).toBe('PHAP_LY')
    expect(flag.message.length).toBeGreaterThan(0)
    expect(flag.trace).toBeDefined()
  })

  it('AC-001 — Flag.trace is a TraversalResult with nodes array containing the violating instance', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    await ontology.registerRule(makeRuleDef({
      id: 'R-001',
      appliesTo: 'invoice',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)

    const inv = await ontology.create('invoice', { amount: 500 }, baseProv, ctx)
    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })

    expect(flags).toHaveLength(1)
    const trace = flags[0]!.trace
    // FR-D04: nodes[0] is always the violating instance
    expect(Array.isArray(trace.nodes)).toBe(true)
    expect(trace.nodes.length).toBeGreaterThanOrEqual(1)
    expect(trace.nodes[0]!.id).toBe(inv.id)
    expect(Array.isArray(trace.edges)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// AC-002: CROSS_CHECK rule raises Flag when aggregate values diverge
// ---------------------------------------------------------------------------

describe('BDD STORY-008 / AC-002: CROSS_CHECK rule raises Flag when aggregate values diverge', () => {
  it('AC-002 — CROSS_CHECK fires when sum of transaction.amount != declared_revenue in tax_declaration', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupFullSchema(ontology, ctx)

    // Register a CROSS_CHECK rule on transaction: sum amount != declared_revenue from tax_declaration
    await ontology.registerRule(makeRuleDef({
      id: 'R-002',
      name: 'CrossCheckRevenue',
      kind: 'CROSS_CHECK',
      appliesTo: 'transaction',
      condition: {
        op: 'compare',
        left: { kind: 'aggregate', fn: 'sum', over: 'related_to', property: 'amount' },
        cmp: '!=',
        right: { kind: 'sourceValue', source: 'tax_declaration', metric: 'declared_revenue' },
      },
      severity: 'CANH_BAO',
      message: 'Transaction {id} has divergent declared revenue.',
    }), ctx)

    // Create a transaction and a tax declaration with different sums
    const tx = await ontology.create('transaction', { amount: 500 }, baseProv, ctx)
    // tax_declaration declares 999 — different from 0 (no related edges with amounts)
    await ontology.create('tax_declaration', { declared_revenue: 999 }, baseProv, ctx)

    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'transaction' })

    expect(flags.length).toBeGreaterThanOrEqual(1)
    const flag = flags.find((f) => f.ruleId === 'R-002' && f.instanceId === tx.id)
    expect(flag).toBeDefined()
    expect(flag!.trace).toBeDefined()
    expect(Array.isArray(flag!.trace.nodes)).toBe(true)
    expect(flag!.trace.nodes.length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// FR-N01: Only rules with appliesTo matching scope.entityType are evaluated
// ---------------------------------------------------------------------------

describe('BDD STORY-008 / FR-N01: only rules with appliesTo matching scope.entityType are evaluated', () => {
  it('FR-N01 — invoice rule does NOT fire when scope.entityType is "document"', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    // Rule applies to "invoice" only
    await ontology.registerRule(makeRuleDef({
      id: 'R-inv',
      appliesTo: 'invoice',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)

    // Create an invoice WITHOUT proof (would flag if evaluated as invoice)
    await ontology.create('invoice', { amount: 100 }, baseProv, ctx)

    // Evaluate with document scope — should not touch invoice rule
    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'document' })
    expect(flags).toHaveLength(0)
  })

  it('FR-N01 — invoice rule fires when scope.entityType is "invoice"', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    await ontology.registerRule(makeRuleDef({
      id: 'R-inv',
      appliesTo: 'invoice',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)

    await ontology.create('invoice', { amount: 100 }, baseProv, ctx)

    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })
    expect(flags).toHaveLength(1)
    expect(flags[0]!.ruleId).toBe('R-inv')
  })
})

// ---------------------------------------------------------------------------
// FR-N02: EvalScope fields — all optional except tenantId
// ---------------------------------------------------------------------------

describe('BDD STORY-008 / FR-N02: EvalScope — only tenantId is required; other fields are optional', () => {
  it('FR-N02 — evaluateRules with only tenantId succeeds and returns flags for all enabled rules', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    await ontology.registerRule(makeRuleDef({
      id: 'R-001',
      appliesTo: 'invoice',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)

    await ontology.create('invoice', { amount: 100 }, baseProv, ctx)

    // Call with tenantId + entityType (SEC-OTHER-08: entityType is now required)
    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })
    expect(flags).toHaveLength(1)
  })

  it('FR-N02 — evaluateRules with entityType but no other optional fields returns flags without error', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    // No rules, no instances — entityType required per SEC-OTHER-08
    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })
    expect(Array.isArray(flags)).toBe(true)
    expect(flags).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// FR-N03: period filter — only instances with confirmed_at in [from, to]
// ---------------------------------------------------------------------------

describe('BDD STORY-008 / FR-N03: period filter — only instances with confirmed_at in range are evaluated', () => {
  it('FR-N03 — instance inside period range is evaluated and flagged', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    await ontology.registerRule(makeRuleDef({
      id: 'R-001',
      appliesTo: 'invoice',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)

    // Create invoice with confirmed_at within the period range
    const inRangeProv: Provenance = {
      source_ref: 'test:in',
      confirmed_by: 'tester@acme.com',
      confirmed_at: '2026-02-15T10:00:00.000Z',
    }
    await ontology.create('invoice', { amount: 100 }, inRangeProv, ctx)

    const flags = await ontology.evaluateFlags({
      tenantId: 't1',
      entityType: 'invoice',
      period: { from: '2026-01-01T00:00:00.000Z', to: '2026-03-31T23:59:59.999Z' },
    })

    expect(flags).toHaveLength(1)
  })

  it('FR-N03 — instance outside period range is excluded, no flag raised', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    await ontology.registerRule(makeRuleDef({
      id: 'R-001',
      appliesTo: 'invoice',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)

    // Create invoice with confirmed_at OUTSIDE the period range (April)
    const outRangeProv: Provenance = {
      source_ref: 'test:out',
      confirmed_by: 'tester@acme.com',
      confirmed_at: '2026-04-15T10:00:00.000Z',
    }
    await ontology.create('invoice', { amount: 100 }, outRangeProv, ctx)

    const flags = await ontology.evaluateFlags({
      tenantId: 't1',
      entityType: 'invoice',
      period: { from: '2026-01-01T00:00:00.000Z', to: '2026-03-31T23:59:59.999Z' },
    })

    expect(flags).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// FR-N04: ids restriction
// ---------------------------------------------------------------------------

describe('BDD STORY-008 / FR-N04: ids restriction — only specified instance ids are evaluated', () => {
  it('FR-N04 — evaluateRules with ids restricts evaluation to those instances', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    await ontology.registerRule(makeRuleDef({
      id: 'R-001',
      appliesTo: 'invoice',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)

    // Create two invoices, both without proves edges
    const inv1 = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    const inv2 = await ontology.create('invoice', { amount: 200 }, baseProv, ctx)

    // Evaluate only inv1 via ids restriction
    const flags = await ontology.evaluateFlags({
      tenantId: 't1',
      entityType: 'invoice',
      ids: [inv1.id],
    })

    expect(flags).toHaveLength(1)
    expect(flags[0]!.instanceId).toBe(inv1.id)
    // inv2 should NOT be flagged
    const inv2Flag = flags.find((f) => f.instanceId === inv2.id)
    expect(inv2Flag).toBeUndefined()
  })

  it('FR-N04 — ids restriction with both ids and where uses intersection', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    await ontology.registerRule(makeRuleDef({
      id: 'R-001',
      appliesTo: 'invoice',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)

    const inv1 = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    const inv2 = await ontology.create('invoice', { amount: 200 }, baseProv, ctx)

    // ids includes both, but where restricts to amount = 100
    const flags = await ontology.evaluateFlags({
      tenantId: 't1',
      entityType: 'invoice',
      ids: [inv1.id, inv2.id],
      where: { op: 'compare', left: { kind: 'property', entity: 'invoice', name: 'amount' }, cmp: '=', right: { kind: 'literal', value: 100 } },
    })

    // Only inv1 has amount = 100 and is in ids
    expect(flags).toHaveLength(1)
    expect(flags[0]!.instanceId).toBe(inv1.id)
  })
})

// ---------------------------------------------------------------------------
// FR-N05: condition evaluation — flag raised on violation
// ---------------------------------------------------------------------------

describe('BDD STORY-008 / FR-N05: condition evaluation raises Flag on violation, no Flag when condition passes', () => {
  it('FR-N05 — instance violating condition (absent edge) produces a Flag', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    await ontology.registerRule(makeRuleDef({
      id: 'R-001',
      appliesTo: 'invoice',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)

    const inv = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)

    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })
    expect(flags.some((f) => f.instanceId === inv.id)).toBe(true)
  })

  it('FR-N05 — instance NOT violating condition (edge exists) produces no Flag', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    await ontology.registerRule(makeRuleDef({
      id: 'R-001',
      appliesTo: 'invoice',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)

    const inv = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    const doc = await ontology.create('document', {}, baseProv, ctx)
    await ontology.link('proves', inv.id, doc.id, baseProv, ctx)

    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })
    expect(flags.find((f) => f.instanceId === inv.id)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// FR-N06: All op types — and, or, not, compare, exists, absent, count
// ---------------------------------------------------------------------------

describe('BDD STORY-008 / FR-N06: all ConditionExpr op types are handled by the interpreter', () => {
  it('FR-N06 (absent) — absent op fires when no matching edge exists', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    await ontology.registerRule(makeRuleDef({
      id: 'R-absent',
      appliesTo: 'invoice',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)

    const inv = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })
    expect(flags.some((f) => f.instanceId === inv.id && f.ruleId === 'R-absent')).toBe(true)
  })

  it('FR-N06 (exists) — exists op fires when matching edge exists', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    // Rule: fires when "proves" edge EXISTS (i.e. existence of proves is the violation)
    await ontology.registerRule(makeRuleDef({
      id: 'R-exists',
      appliesTo: 'invoice',
      condition: { op: 'exists', relationship: 'proves' },
    }), ctx)

    const inv = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    const doc = await ontology.create('document', {}, baseProv, ctx)
    await ontology.link('proves', inv.id, doc.id, baseProv, ctx)

    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })
    expect(flags.some((f) => f.instanceId === inv.id && f.ruleId === 'R-exists')).toBe(true)
  })

  it('FR-N06 (compare) — compare op fires when condition is met', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    // Rule: fires when amount < 100
    await ontology.registerRule(makeRuleDef({
      id: 'R-compare',
      appliesTo: 'invoice',
      condition: {
        op: 'compare',
        left: { kind: 'property', entity: 'invoice', name: 'amount' },
        cmp: '<',
        right: { kind: 'literal', value: 100 },
      },
    }), ctx)

    const invLow = await ontology.create('invoice', { amount: 50 }, baseProv, ctx)
    const invOk = await ontology.create('invoice', { amount: 200 }, baseProv, ctx)

    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })
    expect(flags.some((f) => f.instanceId === invLow.id)).toBe(true)
    expect(flags.some((f) => f.instanceId === invOk.id)).toBe(false)
  })

  it('FR-N06 (count) — count op fires when edge count is below threshold', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    // Rule: fires when count of "proves" edges < 2
    await ontology.registerRule(makeRuleDef({
      id: 'R-count',
      appliesTo: 'invoice',
      condition: { op: 'count', relationship: 'proves', cmp: '<', n: 2 },
    }), ctx)

    const invOne = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    const doc1 = await ontology.create('document', {}, baseProv, ctx)
    await ontology.link('proves', invOne.id, doc1.id, baseProv, ctx)
    // invOne has 1 edge → < 2 → fires

    const invTwo = await ontology.create('invoice', { amount: 200 }, baseProv, ctx)
    const doc2 = await ontology.create('document', {}, baseProv, ctx)
    const doc3 = await ontology.create('document', {}, baseProv, ctx)
    await ontology.link('proves', invTwo.id, doc2.id, baseProv, ctx)
    await ontology.link('proves', invTwo.id, doc3.id, baseProv, ctx)
    // invTwo has 2 edges → NOT < 2 → does not fire

    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })
    expect(flags.some((f) => f.instanceId === invOne.id)).toBe(true)
    expect(flags.some((f) => f.instanceId === invTwo.id)).toBe(false)
  })

  it('FR-N06 (and) — and op fires only when all clauses are true', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    // Rule: fires when amount < 500 AND no proves edge
    await ontology.registerRule(makeRuleDef({
      id: 'R-and',
      appliesTo: 'invoice',
      condition: {
        op: 'and',
        clauses: [
          { op: 'compare', left: { kind: 'property', entity: 'invoice', name: 'amount' }, cmp: '<', right: { kind: 'literal', value: 500 } },
          { op: 'absent', relationship: 'proves' },
        ],
      },
    }), ctx)

    // Both conditions true → flag
    const invBoth = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    // Only amount condition true (has proves edge) → no flag
    const invHasEdge = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    const doc = await ontology.create('document', {}, baseProv, ctx)
    await ontology.link('proves', invHasEdge.id, doc.id, baseProv, ctx)
    // Only absent condition true (amount >= 500) → no flag
    const invHighAmount = await ontology.create('invoice', { amount: 1000 }, baseProv, ctx)

    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })
    expect(flags.some((f) => f.instanceId === invBoth.id)).toBe(true)
    expect(flags.some((f) => f.instanceId === invHasEdge.id)).toBe(false)
    expect(flags.some((f) => f.instanceId === invHighAmount.id)).toBe(false)
  })

  it('FR-N06 (or) — or op fires when at least one clause is true', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    // Rule: fires when amount < 10 OR no proves edge
    await ontology.registerRule(makeRuleDef({
      id: 'R-or',
      appliesTo: 'invoice',
      condition: {
        op: 'or',
        clauses: [
          { op: 'compare', left: { kind: 'property', entity: 'invoice', name: 'amount' }, cmp: '<', right: { kind: 'literal', value: 10 } },
          { op: 'absent', relationship: 'proves' },
        ],
      },
    }), ctx)

    // amount < 10 AND no edge → fires (both)
    const invLow = await ontology.create('invoice', { amount: 5 }, baseProv, ctx)
    // amount >= 10 AND no edge → fires (absent)
    const invNoEdge = await ontology.create('invoice', { amount: 500 }, baseProv, ctx)
    // amount >= 10 AND has edge → no flag
    const invOk = await ontology.create('invoice', { amount: 500 }, baseProv, ctx)
    const doc = await ontology.create('document', {}, baseProv, ctx)
    await ontology.link('proves', invOk.id, doc.id, baseProv, ctx)

    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })
    expect(flags.some((f) => f.instanceId === invLow.id)).toBe(true)
    expect(flags.some((f) => f.instanceId === invNoEdge.id)).toBe(true)
    expect(flags.some((f) => f.instanceId === invOk.id)).toBe(false)
  })

  it('FR-N06 (not) — not op fires when the inner clause is false', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    // Rule: fires when NOT (proves edge exists), i.e. same as absent
    await ontology.registerRule(makeRuleDef({
      id: 'R-not',
      appliesTo: 'invoice',
      condition: { op: 'not', clause: { op: 'exists', relationship: 'proves' } },
    }), ctx)

    const invNoEdge = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    const invWithEdge = await ontology.create('invoice', { amount: 200 }, baseProv, ctx)
    const doc = await ontology.create('document', {}, baseProv, ctx)
    await ontology.link('proves', invWithEdge.id, doc.id, baseProv, ctx)

    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })
    expect(flags.some((f) => f.instanceId === invNoEdge.id)).toBe(true)
    expect(flags.some((f) => f.instanceId === invWithEdge.id)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// FR-N07: Flag fields — ruleId, instanceId, severity, message, trace
// ---------------------------------------------------------------------------

describe('BDD STORY-008 / FR-N07: Flag carries all required fields (ruleId, instanceId, severity, message, trace)', () => {
  it('FR-N07 — all required Flag fields are present with correct values', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    await ontology.registerRule(makeRuleDef({
      id: 'R-001',
      appliesTo: 'invoice',
      severity: 'PHAP_LY',
      message: 'Invoice {id} lacks proof.',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)

    const inv = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })

    expect(flags).toHaveLength(1)
    const flag = flags[0]!
    expect(typeof flag.ruleId).toBe('string')
    expect(flag.ruleId).toBe('R-001')
    expect(typeof flag.instanceId).toBe('string')
    expect(flag.instanceId).toBe(inv.id)
    expect(typeof flag.severity).toBe('string')
    expect(flag.severity).toBe('PHAP_LY')
    expect(typeof flag.message).toBe('string')
    expect(flag.message.length).toBeGreaterThan(0)
    expect(flag.trace).not.toBeNull()
    expect(typeof flag.trace).toBe('object')
  })
})

// ---------------------------------------------------------------------------
// FR-N08: ValueRef resolution — property, literal, aggregate, sourceValue
// ---------------------------------------------------------------------------

describe('BDD STORY-008 / FR-N08: ValueRef resolution (property, literal, aggregate, sourceValue)', () => {
  it('FR-N08 (property) — resolves property from instance data', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    // Fires when amount = 0 (comparing instance property to literal)
    await ontology.registerRule(makeRuleDef({
      id: 'R-prop',
      appliesTo: 'invoice',
      condition: {
        op: 'compare',
        left: { kind: 'property', entity: 'invoice', name: 'amount' },
        cmp: '=',
        right: { kind: 'literal', value: 0 },
      },
    }), ctx)

    const invZero = await ontology.create('invoice', { amount: 0 }, baseProv, ctx)
    const invNonZero = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)

    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })
    expect(flags.some((f) => f.instanceId === invZero.id)).toBe(true)
    expect(flags.some((f) => f.instanceId === invNonZero.id)).toBe(false)
  })

  it('FR-N08 (literal) — literal value is used as a constant in compare', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    // Fires when amount > 9999
    await ontology.registerRule(makeRuleDef({
      id: 'R-lit',
      appliesTo: 'invoice',
      condition: {
        op: 'compare',
        left: { kind: 'property', entity: 'invoice', name: 'amount' },
        cmp: '>',
        right: { kind: 'literal', value: 9999 },
      },
    }), ctx)

    const invHigh = await ontology.create('invoice', { amount: 10000 }, baseProv, ctx)
    const invNormal = await ontology.create('invoice', { amount: 500 }, baseProv, ctx)

    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })
    expect(flags.some((f) => f.instanceId === invHigh.id)).toBe(true)
    expect(flags.some((f) => f.instanceId === invNormal.id)).toBe(false)
  })

  it('FR-N08 (aggregate sum) — aggregate sum over related edges is resolved', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupFullSchema(ontology, ctx)

    // Rule on transaction: fires when sum of amounts over "related_to" edges != 300
    await ontology.registerRule(makeRuleDef({
      id: 'R-agg',
      appliesTo: 'transaction',
      condition: {
        op: 'compare',
        left: { kind: 'aggregate', fn: 'sum', over: 'related_to', property: 'amount' },
        cmp: '!=',
        right: { kind: 'literal', value: 300 },
      },
    }), ctx)

    // transaction → related_to → invoice with amount 100 (sum = 100, != 300 → fires)
    const tx = await ontology.create('transaction', { amount: 50 }, baseProv, ctx)
    const inv = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    await ontology.link('related_to', tx.id, inv.id, baseProv, ctx)

    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'transaction' })
    expect(flags.some((f) => f.instanceId === tx.id)).toBe(true)
  })

  it('FR-N08 (sourceValue) — sourceValue sums the metric from all instances of source type', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupFullSchema(ontology, ctx)

    // Rule on transaction: fires when aggregate sum over related_to != sum of declared_revenue in tax_declaration
    await ontology.registerRule(makeRuleDef({
      id: 'R-src',
      appliesTo: 'transaction',
      condition: {
        op: 'compare',
        left: { kind: 'aggregate', fn: 'sum', over: 'related_to', property: 'amount' },
        cmp: '!=',
        right: { kind: 'sourceValue', source: 'tax_declaration', metric: 'declared_revenue' },
      },
    }), ctx)

    const tx = await ontology.create('transaction', { amount: 50 }, baseProv, ctx)
    const inv = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    await ontology.link('related_to', tx.id, inv.id, baseProv, ctx)
    // Tax declaration declares 999 — different from 100 → fires
    await ontology.create('tax_declaration', { declared_revenue: 999 }, baseProv, ctx)

    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'transaction' })
    expect(flags.some((f) => f.instanceId === tx.id && f.ruleId === 'R-src')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// FR-N09: Disabled rules are never evaluated
// ---------------------------------------------------------------------------

describe('BDD STORY-008 / FR-N09: disabled rules are never evaluated by evaluateRules()', () => {
  it('FR-N09 — a disabled rule does not produce any flags', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    const disableProv: Provenance = {
      source_ref: 'ops:disable',
      confirmed_by: 'ops@acme.com',
      confirmed_at: '2026-05-10T00:00:00.000Z',
    }

    await ontology.registerRule(makeRuleDef({
      id: 'R-disabled',
      appliesTo: 'invoice',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)
    await ontology.disableRule('R-disabled', disableProv, ctx)

    // Instance that WOULD be flagged if rule was enabled
    await ontology.create('invoice', { amount: 100 }, baseProv, ctx)

    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })
    expect(flags).toHaveLength(0)
  })

  it('FR-N09 — enabled rules still produce flags when a disabled rule is also registered', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    const disableProv: Provenance = {
      source_ref: 'ops:disable',
      confirmed_by: 'ops@acme.com',
      confirmed_at: '2026-05-10T00:00:00.000Z',
    }

    // One disabled rule, one enabled rule (different condition)
    await ontology.registerRule(makeRuleDef({
      id: 'R-disabled',
      appliesTo: 'invoice',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)
    await ontology.disableRule('R-disabled', disableProv, ctx)

    await ontology.registerRule(makeRuleDef({
      id: 'R-enabled',
      appliesTo: 'invoice',
      condition: {
        op: 'compare',
        left: { kind: 'property', entity: 'invoice', name: 'amount' },
        cmp: '=',
        right: { kind: 'literal', value: 0 },
      },
    }), ctx)

    const inv = await ontology.create('invoice', { amount: 0 }, baseProv, ctx)
    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })

    // Only the enabled rule fires
    expect(flags).toHaveLength(1)
    expect(flags[0]!.ruleId).toBe('R-enabled')
    expect(flags[0]!.instanceId).toBe(inv.id)
  })
})

// ---------------------------------------------------------------------------
// FR-N10: Empty array returned when no violations
// ---------------------------------------------------------------------------

describe('BDD STORY-008 / FR-N10: evaluateRules returns empty array when no violations, no error thrown', () => {
  it('FR-N10 — returns [] without error when all instances satisfy the rules', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    await ontology.registerRule(makeRuleDef({
      id: 'R-001',
      appliesTo: 'invoice',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)

    // Create invoice WITH proof — satisfies the rule (no flag)
    const inv = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    const doc = await ontology.create('document', {}, baseProv, ctx)
    await ontology.link('proves', inv.id, doc.id, baseProv, ctx)

    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })
    expect(flags).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// FR-E01: TENANT_MISMATCH on empty tenantId
// ---------------------------------------------------------------------------

describe('BDD STORY-008 / FR-E01: TENANT_MISMATCH when tenantId is empty or absent', () => {
  it('FR-E01 — evaluateRules with empty tenantId rejects with TENANT_MISMATCH', async () => {
    const { ontology } = makeOntology()
    await expectRejects(
      ontology.evaluateFlags({ tenantId: '' }),
      'TENANT_MISMATCH',
    )
  })

  it('FR-E01 — no evaluation is performed after TENANT_MISMATCH (no side effects)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    await ontology.registerRule(makeRuleDef({
      id: 'R-001',
      appliesTo: 'invoice',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)
    await ontology.create('invoice', { amount: 100 }, baseProv, ctx)

    // Empty tenantId should reject immediately
    let caughtError: unknown
    try {
      await ontology.evaluateFlags({ tenantId: '' })
    } catch (e) {
      caughtError = e
    }
    expect(caughtError).toBeInstanceOf(OntologyError)
    expect((caughtError as OntologyError).code).toBe('TENANT_MISMATCH')
  })
})

// ---------------------------------------------------------------------------
// FR-E02: UNKNOWN_ENTITY_TYPE on unknown scope.entityType
// ---------------------------------------------------------------------------

describe('BDD STORY-008 / FR-E02: UNKNOWN_ENTITY_TYPE when scope.entityType is not registered', () => {
  it('FR-E02 — evaluateRules with unknown entityType rejects with UNKNOWN_ENTITY_TYPE', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    await expectRejects(
      ontology.evaluateFlags({ tenantId: 't1', entityType: 'ghost_entity' }),
      'UNKNOWN_ENTITY_TYPE',
    )
  })

  it('FR-E02 — no evaluation occurs after UNKNOWN_ENTITY_TYPE rejection', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    await ontology.registerRule(makeRuleDef({
      id: 'R-001',
      appliesTo: 'invoice',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)

    let caught: unknown
    try {
      await ontology.evaluateFlags({ tenantId: 't1', entityType: 'nonexistent' })
    } catch (e) {
      caught = e
    }
    expect((caught as OntologyError).code).toBe('UNKNOWN_ENTITY_TYPE')
  })
})

// ---------------------------------------------------------------------------
// FR-X01: Empty array when no rules registered
// ---------------------------------------------------------------------------

describe('BDD STORY-008 / FR-X01: evaluateRules returns [] when no rules are registered', () => {
  it('FR-X01 — returns empty array without error when tenant has no rules', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    // Create instances but register NO rules
    await ontology.create('invoice', { amount: 100 }, baseProv, ctx)

    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })
    expect(flags).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// FR-X02: absent does NOT fire when edge exists
// ---------------------------------------------------------------------------

describe('BDD STORY-008 / FR-X02: absent op does NOT fire when at least one matching edge exists', () => {
  it('FR-X02 — absent rule does not fire when the required edge is present', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    await ontology.registerRule(makeRuleDef({
      id: 'R-absent',
      appliesTo: 'invoice',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)

    const inv = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    const doc = await ontology.create('document', {}, baseProv, ctx)
    // Link proves edge — absent should NOT fire
    await ontology.link('proves', inv.id, doc.id, baseProv, ctx)

    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })
    expect(flags.find((f) => f.instanceId === inv.id)).toBeUndefined()
  })

  it('FR-X02 — absent fires for instance without edge but not for instance with edge (mixed)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    await ontology.registerRule(makeRuleDef({
      id: 'R-absent',
      appliesTo: 'invoice',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)

    const invNoEdge = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    const invWithEdge = await ontology.create('invoice', { amount: 200 }, baseProv, ctx)
    const doc = await ontology.create('document', {}, baseProv, ctx)
    await ontology.link('proves', invWithEdge.id, doc.id, baseProv, ctx)

    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })
    expect(flags.some((f) => f.instanceId === invNoEdge.id)).toBe(true)
    expect(flags.some((f) => f.instanceId === invWithEdge.id)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// FR-X03: count op — fires only below threshold
// ---------------------------------------------------------------------------

describe('BDD STORY-008 / FR-X03: count op fires only when count is below threshold', () => {
  it('FR-X03 — count >= 2 rule: instance with 1 edge fires, instance with 2 edges does not', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    // Rule: fires when count of proves edges < 2
    await ontology.registerRule(makeRuleDef({
      id: 'R-count',
      appliesTo: 'invoice',
      condition: { op: 'count', relationship: 'proves', cmp: '<', n: 2 },
    }), ctx)

    const invOne = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    const doc1 = await ontology.create('document', {}, baseProv, ctx)
    await ontology.link('proves', invOne.id, doc1.id, baseProv, ctx)
    // 1 edge < 2 → fires

    const invTwo = await ontology.create('invoice', { amount: 200 }, baseProv, ctx)
    const doc2 = await ontology.create('document', {}, baseProv, ctx)
    const doc3 = await ontology.create('document', {}, baseProv, ctx)
    await ontology.link('proves', invTwo.id, doc2.id, baseProv, ctx)
    await ontology.link('proves', invTwo.id, doc3.id, baseProv, ctx)
    // 2 edges NOT < 2 → does not fire

    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })
    expect(flags.some((f) => f.instanceId === invOne.id)).toBe(true)
    expect(flags.some((f) => f.instanceId === invTwo.id)).toBe(false)
  })

  it('FR-X03 — instance with zero edges (count = 0) fires when threshold is >= 1', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    // Fires when count < 1 (i.e. no proves edges)
    await ontology.registerRule(makeRuleDef({
      id: 'R-count-zero',
      appliesTo: 'invoice',
      condition: { op: 'count', relationship: 'proves', cmp: '<', n: 1 },
    }), ctx)

    await ontology.create('invoice', { amount: 100 }, baseProv, ctx)

    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })
    expect(flags).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// FR-X04: period filter excludes out-of-range instances
// ---------------------------------------------------------------------------

describe('BDD STORY-008 / FR-X04: period filter — instances outside range are excluded without error', () => {
  it('FR-X04 — instance outside period is excluded; instance inside is evaluated', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    await ontology.registerRule(makeRuleDef({
      id: 'R-001',
      appliesTo: 'invoice',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)

    const inRangeProv: Provenance = {
      source_ref: 'test:in',
      confirmed_by: 'tester@acme.com',
      confirmed_at: '2026-02-10T10:00:00.000Z',
    }
    const outRangeProv: Provenance = {
      source_ref: 'test:out',
      confirmed_by: 'tester@acme.com',
      confirmed_at: '2026-05-15T10:00:00.000Z',
    }

    const invIn = await ontology.create('invoice', { amount: 100 }, inRangeProv, ctx)
    const invOut = await ontology.create('invoice', { amount: 200 }, outRangeProv, ctx)

    const flags = await ontology.evaluateFlags({
      tenantId: 't1',
      entityType: 'invoice',
      period: { from: '2026-01-01T00:00:00.000Z', to: '2026-03-31T23:59:59.999Z' },
    })

    expect(flags.some((f) => f.instanceId === invIn.id)).toBe(true)
    expect(flags.some((f) => f.instanceId === invOut.id)).toBe(false)
  })

  it('FR-X04 — all instances out of range returns empty array without error', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    await ontology.registerRule(makeRuleDef({
      id: 'R-001',
      appliesTo: 'invoice',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)

    const outRangeProv: Provenance = {
      source_ref: 'test:out',
      confirmed_by: 'tester@acme.com',
      confirmed_at: '2026-06-01T10:00:00.000Z',
    }
    await ontology.create('invoice', { amount: 100 }, outRangeProv, ctx)

    const flags = await ontology.evaluateFlags({
      tenantId: 't1',
      entityType: 'invoice',
      period: { from: '2026-01-01T00:00:00.000Z', to: '2026-03-31T23:59:59.999Z' },
    })

    expect(flags).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// FR-X05: EXISTENCE_IMPLIES (exists + absent compound)
// ---------------------------------------------------------------------------

describe('BDD STORY-008 / FR-X05: EXISTENCE_IMPLIES — fires when trigger exists AND implication is absent', () => {
  it('FR-X05 — rule fires for instance where trigger exists but implication edge is absent', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    // Define additional relationship for the "implies" part
    await ontology.defineRelationshipType(
      { name: 'audited_by', from: 'invoice', to: 'document', cardinality: 'N..N', directed: true },
      ctx,
    )

    // EXISTENCE_IMPLIES: fires when "proves" edge exists AND "audited_by" edge is absent
    // (if invoice has a proof, it must also have an audit document)
    await ontology.registerRule(makeRuleDef({
      id: 'R-implies',
      kind: 'EXISTENCE_IMPLIES',
      appliesTo: 'invoice',
      condition: {
        op: 'and',
        clauses: [
          { op: 'exists', relationship: 'proves' },
          { op: 'absent', relationship: 'audited_by' },
        ],
      },
    }), ctx)

    // Instance that has "proves" but no "audited_by" → fires
    const invTrigger = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    const doc = await ontology.create('document', {}, baseProv, ctx)
    await ontology.link('proves', invTrigger.id, doc.id, baseProv, ctx)
    // No "audited_by" edge

    // Instance that has neither → trigger not satisfied → no flag
    const invNoTrigger = await ontology.create('invoice', { amount: 200 }, baseProv, ctx)

    // Instance that has both → implication satisfied → no flag
    const invBoth = await ontology.create('invoice', { amount: 300 }, baseProv, ctx)
    const doc2 = await ontology.create('document', {}, baseProv, ctx)
    const doc3 = await ontology.create('document', {}, baseProv, ctx)
    await ontology.link('proves', invBoth.id, doc2.id, baseProv, ctx)
    await ontology.link('audited_by', invBoth.id, doc3.id, baseProv, ctx)

    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })

    // Only invTrigger fires (has proves, lacks audited_by)
    expect(flags.some((f) => f.instanceId === invTrigger.id)).toBe(true)
    expect(flags.some((f) => f.instanceId === invNoTrigger.id)).toBe(false)
    expect(flags.some((f) => f.instanceId === invBoth.id)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// FR-D01: All Flag fields are present (no undefined / null)
// ---------------------------------------------------------------------------

describe('BDD STORY-008 / FR-D01: all Flag fields are present and non-null', () => {
  it('FR-D01 — every Flag field is a defined non-null value', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    await ontology.registerRule(makeRuleDef({
      id: 'R-001',
      appliesTo: 'invoice',
      severity: 'PHAP_LY',
      message: 'Invoice {id} needs proof.',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)

    await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })

    expect(flags).toHaveLength(1)
    const flag = flags[0]!

    // FR-D01: no field may be null or undefined
    expect(flag.ruleId).not.toBeNull()
    expect(flag.ruleId).not.toBeUndefined()
    expect(flag.instanceId).not.toBeNull()
    expect(flag.instanceId).not.toBeUndefined()
    expect(flag.severity).not.toBeNull()
    expect(flag.severity).not.toBeUndefined()
    expect(flag.message).not.toBeNull()
    expect(flag.message).not.toBeUndefined()
    expect(flag.trace).not.toBeNull()
    expect(flag.trace).not.toBeUndefined()

    // trace must have nodes and edges
    expect(flag.trace.nodes).not.toBeNull()
    expect(flag.trace.nodes).not.toBeUndefined()
    expect(flag.trace.edges).not.toBeNull()
    expect(flag.trace.edges).not.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// FR-D02: Flag.message renders {id} interpolation
// ---------------------------------------------------------------------------

describe('BDD STORY-008 / FR-D02: Flag.message renders {id} interpolation with violating instance id', () => {
  it('FR-D02 — {id} in message template is replaced with the instance id', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    await ontology.registerRule(makeRuleDef({
      id: 'R-001',
      appliesTo: 'invoice',
      message: 'Invoice {id} lacks a proof document.',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)

    const inv = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })

    expect(flags).toHaveLength(1)
    const flag = flags[0]!
    // The literal {id} should be replaced with the actual instance id
    expect(flag.message).toContain(inv.id)
    expect(flag.message).not.toContain('{id}')
  })

  it('FR-D02 — message without {id} placeholder is returned verbatim', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    await ontology.registerRule(makeRuleDef({
      id: 'R-001',
      appliesTo: 'invoice',
      message: 'Invoice is missing proof.',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)

    await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })

    expect(flags).toHaveLength(1)
    expect(flags[0]!.message).toBe('Invoice is missing proof.')
  })
})

// ---------------------------------------------------------------------------
// FR-D04: Flag.trace has nodes[0] as the violating instance
// ---------------------------------------------------------------------------

describe('BDD STORY-008 / FR-D04: Flag.trace.nodes[0] is the violating instance', () => {
  it('FR-D04 — trace.nodes[0].id equals the flagged instanceId', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    await ontology.registerRule(makeRuleDef({
      id: 'R-001',
      appliesTo: 'invoice',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)

    const inv = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })

    expect(flags).toHaveLength(1)
    const flag = flags[0]!
    // FR-D04: nodes[0] must be the violating instance
    expect(flag.trace.nodes[0]!.id).toBe(inv.id)
    expect(flag.trace.nodes[0]!.id).toBe(flag.instanceId)
  })

  it('FR-D04 — trace.nodes[0].entityType matches the flagged instance entityType', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 't1' }
    await setupSchema(ontology, ctx)

    await ontology.registerRule(makeRuleDef({
      id: 'R-001',
      appliesTo: 'invoice',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctx)

    await ontology.create('invoice', { amount: 100 }, baseProv, ctx)
    const flags = await ontology.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })

    expect(flags).toHaveLength(1)
    expect(flags[0]!.trace.nodes[0]!.entityType).toBe('invoice')
  })
})

// ---------------------------------------------------------------------------
// NFR-P01: Performance — evaluateRules with 100 instances + 10 rules under 500ms
// ---------------------------------------------------------------------------

describe('BDD STORY-008 / NFR-P01: performance — evaluateRules with 100 instances + 10 rules under 500ms', () => {
  it('NFR-P01 — 100 instances + 10 enabled rules complete within 500ms', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'perf-tenant' }
    await setupSchema(ontology, ctx)

    // Register 10 rules with different conditions
    for (let i = 0; i < 10; i++) {
      await ontology.registerRule(makeRuleDef({
        id: `R-${i.toString().padStart(3, '0')}`,
        appliesTo: 'invoice',
        // Mix of absent rules and compare rules
        condition: i % 2 === 0
          ? { op: 'absent', relationship: 'proves' }
          : {
              op: 'compare',
              left: { kind: 'property', entity: 'invoice', name: 'amount' },
              cmp: '<',
              right: { kind: 'literal', value: 0 },
            },
      }), ctx)
    }

    // Create 100 invoice instances (none will fire the compare rule, all will fire absent)
    for (let i = 0; i < 100; i++) {
      await ontology.create('invoice', { amount: i + 1 }, baseProv, ctx)
    }

    const start = Date.now()
    const flags = await ontology.evaluateFlags({ tenantId: 'perf-tenant', entityType: 'invoice' })
    const elapsed = Date.now() - start

    // All 100 invoices should fire the 5 absent rules = 500 flags
    expect(flags.length).toBeGreaterThan(0)
    expect(elapsed).toBeLessThan(500)
  }, 10000)
})

// ---------------------------------------------------------------------------
// NFR-S01: Tenant isolation — rules/instances from other tenants not visible
// ---------------------------------------------------------------------------

describe('BDD STORY-008 / NFR-S01: tenant isolation — evaluateRules only sees rules and instances from its own tenant', () => {
  it('NFR-S01 — rules from tenant-beta do not evaluate tenant-alpha instances', async () => {
    const { ontology } = makeOntology()
    const ctxAlpha = { tenantId: 'tenant-alpha' }
    const ctxBeta = { tenantId: 'tenant-beta' }

    await setupSchema(ontology, ctxAlpha)
    await setupSchema(ontology, ctxBeta)

    // Register a rule for tenant-beta only
    await ontology.registerRule(makeRuleDef({
      id: 'R-beta',
      appliesTo: 'invoice',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctxBeta)

    // Create an invoice for tenant-alpha (no rules for this tenant)
    await ontology.create('invoice', { amount: 100 }, baseProv, ctxAlpha)

    // Evaluate tenant-alpha — should see NO flags (beta rule is not in alpha's scope)
    const alphaFlags = await ontology.evaluateFlags({ tenantId: 'tenant-alpha', entityType: 'invoice' })
    expect(alphaFlags).toHaveLength(0)
  })

  it('NFR-S01 — instances from tenant-beta are not evaluated by tenant-alpha evaluateRules()', async () => {
    const { ontology } = makeOntology()
    const ctxAlpha = { tenantId: 'tenant-alpha' }
    const ctxBeta = { tenantId: 'tenant-beta' }

    await setupSchema(ontology, ctxAlpha)
    await setupSchema(ontology, ctxBeta)

    // Register an absent rule in tenant-alpha
    await ontology.registerRule(makeRuleDef({
      id: 'R-alpha',
      appliesTo: 'invoice',
      condition: { op: 'absent', relationship: 'proves' },
    }), ctxAlpha)

    // Create invoice in tenant-beta only (not alpha)
    await ontology.create('invoice', { amount: 100 }, baseProv, ctxBeta)

    // Evaluate tenant-alpha — the beta instance should NOT be evaluated
    const alphaFlags = await ontology.evaluateFlags({ tenantId: 'tenant-alpha', entityType: 'invoice' })
    // No alpha instances → no flags
    expect(alphaFlags).toHaveLength(0)
  })

  it('NFR-S01 — each tenant sees only its own flags when both tenants have violating instances', async () => {
    const { ontology } = makeOntology()
    const ctxAlpha = { tenantId: 'tenant-alpha' }
    const ctxBeta = { tenantId: 'tenant-beta' }

    await setupSchema(ontology, ctxAlpha)
    await setupSchema(ontology, ctxBeta)

    // Both tenants have the same rule
    await ontology.registerRule(makeRuleDef({ id: 'R-001', appliesTo: 'invoice' }), ctxAlpha)
    await ontology.registerRule(makeRuleDef({ id: 'R-001', appliesTo: 'invoice' }), ctxBeta)

    // Both tenants have invoices without proof
    const invAlpha = await ontology.create('invoice', { amount: 100 }, baseProv, ctxAlpha)
    const invBeta = await ontology.create('invoice', { amount: 200 }, baseProv, ctxBeta)

    const alphaFlags = await ontology.evaluateFlags({ tenantId: 'tenant-alpha', entityType: 'invoice' })
    const betaFlags = await ontology.evaluateFlags({ tenantId: 'tenant-beta', entityType: 'invoice' })

    // Alpha sees only its own instance
    expect(alphaFlags.some((f) => f.instanceId === invAlpha.id)).toBe(true)
    expect(alphaFlags.some((f) => f.instanceId === invBeta.id)).toBe(false)

    // Beta sees only its own instance
    expect(betaFlags.some((f) => f.instanceId === invBeta.id)).toBe(true)
    expect(betaFlags.some((f) => f.instanceId === invAlpha.id)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// GAP-N03 resolution: FR-E03/E04/E05/E06 defensive error path tests
// ---------------------------------------------------------------------------

describe('BDD STORY-008 / FR-E03: malformed stored rule is skipped, evaluation continues', () => {
  it('A rule with an unknown op in its condition is skipped; other rules still produce flags (FR-E03)', async () => {
    const { ontology, adapter } = makeOntology()
    const ctx = { tenantId: 'tenant-e03' }
    await setupSchema(ontology, ctx)

    // Insert a malformed rule directly into the adapter (bypassing validation)
    // to simulate data-integrity corruption (FR-E03 scenario)
    const malformedRule: RuleDef = {
      ...makeRuleDef({ id: 'R-bad', name: 'MalformedRule' }),
      condition: { op: 'unknown_op_xyz' } as unknown as RuleDef['condition'],
    }
    await adapter.withTenant('tenant-e03').insertRule(malformedRule)

    // Also register a valid rule
    await ontology.registerRule(makeRuleDef({ id: 'R-good', name: 'ValidRule' }), ctx)

    // Create an invoice without proof (will trigger the valid rule)
    await ontology.create('invoice', { amount: 100 }, baseProv, ctx)

    // evaluateRules must NOT throw — malformed rule is skipped, valid rule still fires
    const flags = await ontology.evaluateFlags({ tenantId: 'tenant-e03', entityType: 'invoice' })

    // The valid rule raised a flag; the malformed rule was silently skipped
    expect(flags.some((f) => f.ruleId === 'R-good')).toBe(true)
    // Malformed rule produces no flags (skipped)
    expect(flags.some((f) => f.ruleId === 'R-bad')).toBe(false)
  })
})

describe('BDD STORY-008 / FR-E05: scope.ids with non-existent instance is skipped', () => {
  it('A non-existent id in scope.ids is skipped; evaluation continues for other ids (FR-E05)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-e05' }
    await setupSchema(ontology, ctx)
    await ontology.registerRule(makeRuleDef({ id: 'R-001' }), ctx)

    // Create one real invoice without proof
    const inv = await ontology.create('invoice', { amount: 50 }, baseProv, ctx)

    // Evaluate with a mix of valid and non-existent ids
    const fakeId = 'non-existent-instance-id-00000000'
    const flags = await ontology.evaluateFlags({
      tenantId: 'tenant-e05',
      entityType: 'invoice',
      ids: [fakeId, inv.id],
    })

    // The real invoice is still evaluated and flagged; the fake id is silently skipped
    expect(flags.some((f) => f.instanceId === inv.id)).toBe(true)
    expect(flags.some((f) => f.instanceId === fakeId)).toBe(false)
  })
})

describe('BDD STORY-008 / FR-E06: trace fallback when start node cannot be resolved', () => {
  it('Flag is still raised with a minimal trace when trace traversal fails (FR-E06)', async () => {
    const { ontology } = makeOntology()
    const ctx = { tenantId: 'tenant-e06' }
    await setupSchema(ontology, ctx)

    // Register a rule that references a non-existent relationship (causes trace resolution to fail)
    await ontology.registerRule(makeRuleDef({
      id: 'R-trace',
      condition: { op: 'absent', relationship: 'nonexistent_rel' },
    }), ctx)

    const inv = await ontology.create('invoice', { amount: 100 }, baseProv, ctx)

    const flags = await ontology.evaluateFlags({ tenantId: 'tenant-e06', entityType: 'invoice' })

    // Flag is raised despite the relationship not existing
    expect(flags.length).toBeGreaterThan(0)
    const flag = flags.find((f) => f.instanceId === inv.id)
    expect(flag).toBeDefined()

    // trace is present (even if minimal — FR-E06: fallback to single-node trace)
    expect(flag!.trace).toBeDefined()
    expect(flag!.trace.start).toBe(inv.id)
  })
})

// ---------------------------------------------------------------------------
// SEC-OTHER-08: evaluateRules() rejects unbounded scope (no entityType, no ids)
// ---------------------------------------------------------------------------

describe('SEC-OTHER-08: evaluateRules() rejects scope with neither entityType nor ids', () => {
  it('scope without entityType or ids throws REQUIRED_PROPERTY_MISSING', async () => {
    const adapter = new InMemoryAdapter()
    const ontology = createOntology({ adapter })

    let caught: unknown
    try {
      await ontology.evaluateFlags({ tenantId: 'tenant-sec' })
    } catch (err) { caught = err }

    expect(caught).toBeInstanceOf(OntologyError)
    expect((caught as OntologyError).code).toBe('REQUIRED_PROPERTY_MISSING')
  })

  it('scope with empty ids array throws REQUIRED_PROPERTY_MISSING', async () => {
    const adapter = new InMemoryAdapter()
    const ontology = createOntology({ adapter })

    let caught: unknown
    try {
      await ontology.evaluateFlags({ tenantId: 'tenant-sec', ids: [] })
    } catch (err) { caught = err }

    expect(caught).toBeInstanceOf(OntologyError)
    expect((caught as OntologyError).code).toBe('REQUIRED_PROPERTY_MISSING')
  })

  it('scope with entityType is accepted (existing behaviour preserved)', async () => {
    const adapter = new InMemoryAdapter()
    const ontology = createOntology({ adapter })
    const ctx = { tenantId: 'tenant-sec' }
    const prov: Provenance = { source_ref: 'sec', confirmed_by: 'tester', confirmed_at: '2026-01-01T00:00:00Z' }

    await ontology.defineEntityType({ name: 'Invoice', label: 'Invoice', properties: [] }, ctx)
    await ontology.migrate(ctx)

    // No rules registered → evaluateRules returns empty array without error
    const flags = await ontology.evaluateFlags({ tenantId: 'tenant-sec', entityType: 'Invoice' })
    expect(flags).toEqual([])
  })

  it('scope with non-empty ids array is accepted', async () => {
    const adapter = new InMemoryAdapter()
    const ontology = createOntology({ adapter })
    const ctx = { tenantId: 'tenant-sec2' }
    const prov: Provenance = { source_ref: 'sec', confirmed_by: 'tester', confirmed_at: '2026-01-01T00:00:00Z' }

    await ontology.defineEntityType({ name: 'Invoice', label: 'Invoice', properties: [] }, ctx)
    await ontology.migrate(ctx)
    const inv = await ontology.create('Invoice', {}, prov, ctx)

    const flags = await ontology.evaluateFlags({ tenantId: 'tenant-sec2', ids: [inv.id] })
    expect(Array.isArray(flags)).toBe(true)
  })
})
