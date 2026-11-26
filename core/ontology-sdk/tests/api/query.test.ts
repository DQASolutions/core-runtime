/**
 * Unified query (E1.5): the OntologyPort read command — filter by type + where,
 * hop along relationships, limit. (The class implements OntologyPort; that
 * conformance is enforced at build time.)
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createOntology, InMemoryAdapter, type Ontology, type OntologyPort } from '../../src/index.js'

const ctx = { tenantId: 't1' }
const prov = { source_ref: 'src', confirmed_by: 'u', confirmed_at: '2026-01-01T00:00:00.000Z' }

let ont: Ontology

beforeEach(async () => {
  ont = createOntology({ adapter: new InMemoryAdapter() })
  await ont.defineEntityType({ name: 'invoice', label: 'Invoice', properties: [{ name: 'amount', type: 'number' }] }, ctx)
  await ont.defineEntityType({ name: 'document', label: 'Document', properties: [] }, ctx)
  await ont.defineRelationshipType({ name: 'proves', from: 'invoice', to: 'document', cardinality: 'N..N', directed: true }, ctx)
})

describe('query (OntologyPort)', () => {
  it('the Ontology class satisfies OntologyPort', () => {
    const port: OntologyPort = ont // compile + runtime sanity
    expect(typeof port.applyAction).toBe('function')
    expect(typeof port.callFunction).toBe('function')
    expect(typeof port.query).toBe('function')
    expect(typeof port.evaluateRules).toBe('function')
  })

  it('filters by type + where', async () => {
    await ont.create('invoice', { amount: 100 }, prov, ctx)
    await ont.create('invoice', { amount: 999 }, prov, ctx)
    const big = await ont.query({ type: 'invoice', where: { op: 'compare', left: { kind: 'property', entity: 'invoice', name: 'amount' }, cmp: '>', right: { kind: 'literal', value: 500 } } }, ctx)
    expect(big).toHaveLength(1)
    expect(big[0]!.data.amount).toBe(999)
  })

  it('hops along a relationship via traverse', async () => {
    const inv = await ont.create('invoice', { amount: 1 }, prov, ctx)
    const doc = await ont.create('document', {}, prov, ctx)
    await ont.link('proves', inv.id, doc.id, prov, ctx)

    const docs = await ont.query({ type: 'invoice', traverse: [{ relationship: 'proves' }] }, ctx)
    expect(docs.map((d) => d.id)).toContain(doc.id)
  })

  it('applies limit', async () => {
    await ont.create('invoice', { amount: 1 }, prov, ctx)
    await ont.create('invoice', { amount: 2 }, prov, ctx)
    await ont.create('invoice', { amount: 3 }, prov, ctx)
    const limited = await ont.query({ type: 'invoice', limit: 2 }, ctx)
    expect(limited).toHaveLength(2)
  })
})
