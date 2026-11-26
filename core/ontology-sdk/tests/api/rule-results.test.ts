/**
 * Neutral rule evaluation (E1.3): evaluateRules → RuleResult[] (no flags, no
 * severity interpretation), carrying the rule's `onFail` intent as data.
 * The flag-shaped projection remains available as evaluateFlags.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createOntology, InMemoryAdapter, type Ontology, type RuleDef } from '../../src/index.js'

const ctx = { tenantId: 't1' }
const prov = { source_ref: 'src', confirmed_by: 'u', confirmed_at: '2026-01-01T00:00:00.000Z' }

let ont: Ontology

const ruleBase: Omit<RuleDef, 'id' | 'condition' | 'onFail'> = {
  name: 'needs-proof',
  kind: 'REQUIRED_RELATION',
  appliesTo: 'invoice',
  severity: 'PHAP_LY',
  message: 'Invoice {id} lacks a proof document.',
  source_ref: 'rule:seed',
  confirmed_by: 'u',
  confirmed_at: '2026-01-01T00:00:00.000Z',
  enabled: true,
  version: 1,
}

beforeEach(async () => {
  ont = createOntology({ adapter: new InMemoryAdapter() })
  await ont.defineEntityType({ name: 'invoice', label: 'Invoice', properties: [{ name: 'amount', type: 'number' }] }, ctx)
  await ont.defineEntityType({ name: 'document', label: 'Document', properties: [] }, ctx)
  await ont.defineRelationshipType({ name: 'proves', from: 'invoice', to: 'document', cardinality: 'N..N', directed: true }, ctx)
})

describe('evaluateRules → RuleResult[] (neutral)', () => {
  it('returns neutral results carrying onFail intent (not flags)', async () => {
    await ont.registerRule(
      {
        ...ruleBase,
        id: 'R-001',
        condition: { op: 'absent', relationship: 'proves' },
        onFail: { action: 'emitFinding', params: { kind: 'missing-proof' }, severityLabel: 'PHAP_LY' },
      } as RuleDef,
      ctx,
    )
    const inv = await ont.create('invoice', { amount: 1000 }, prov, ctx)

    const results = await ont.evaluateRules({ tenantId: 't1', entityType: 'invoice' })
    expect(results).toHaveLength(1)
    const r = results[0]!
    expect(r.ruleId).toBe('R-001')
    expect(r.target).toBe(inv.id) // neutral: `target`, not `instanceId`
    expect(r.fired).toBe(true)
    expect(r.severityLabel).toBe('PHAP_LY') // opaque label, not interpreted
    expect(r.onFail).toEqual({ action: 'emitFinding', params: { kind: 'missing-proof' }, severityLabel: 'PHAP_LY' })
    expect(r.trace).toBeDefined()
  })

  it('omits onFail when the rule declares none', async () => {
    await ont.registerRule(
      { ...ruleBase, id: 'R-002', condition: { op: 'absent', relationship: 'proves' } } as RuleDef,
      ctx,
    )
    await ont.create('invoice', { amount: 1 }, prov, ctx)
    const results = await ont.evaluateRules({ tenantId: 't1', entityType: 'invoice' })
    expect(results).toHaveLength(1)
    expect(results[0]!.onFail).toBeUndefined()
    expect(results[0]!.fired).toBe(true)
  })

  it('evaluateFlags still returns the flag-shaped projection (back-compat)', async () => {
    await ont.registerRule(
      { ...ruleBase, id: 'R-003', condition: { op: 'absent', relationship: 'proves' } } as RuleDef,
      ctx,
    )
    const inv = await ont.create('invoice', { amount: 1 }, prov, ctx)
    const flags = await ont.evaluateFlags({ tenantId: 't1', entityType: 'invoice' })
    expect(flags[0]!.instanceId).toBe(inv.id) // flag shape: instanceId + severity
    expect(flags[0]!.severity).toBe('PHAP_LY')
  })
})
