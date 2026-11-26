/**
 * K11 — `direction` on exists / absent / count.
 *
 * These conditions only ever looked at edges LEAVING the instance, so a rule
 * that needed to ask "does anything point at me" could only be written by
 * declaring the relationship backwards. Edge direction was being chosen by what
 * a rule needed rather than by what the relationship means. `direction` moves
 * that choice back to the rule, and leaves the default where it was.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createOntology, InMemoryAdapter, OntologyError, type Ontology } from '../../src/index.js'

const ctx = { tenantId: 't1' }
const prov = { source_ref: 'src', confirmed_by: 'u', confirmed_at: '2026-01-01T00:00:00.000Z' }

let ont: Ontology
let parent: string
let child: string
let orphan: string

beforeEach(async () => {
  ont = createOntology({ adapter: new InMemoryAdapter() })
  await ont.defineEntityType(
    { name: 'unit', label: 'Unit', properties: [{ name: 'tag', type: 'text' }] },
    ctx,
  )
  await ont.defineRelationshipType(
    { name: 'commands', from: 'unit', to: 'unit', cardinality: 'N..N', directed: true },
    ctx,
  )
  parent = (await ont.create('unit', { tag: 'parent' }, prov, ctx)).id
  child = (await ont.create('unit', { tag: 'child' }, prov, ctx)).id
  orphan = (await ont.create('unit', { tag: 'orphan' }, prov, ctx)).id
  await ont.link('commands', parent, child, prov, ctx)
})

const evaluate = async (id: string, expr: unknown) => {
  const inst = await ont.get(id, ctx)
  const { evaluateRuleCondition } = await import('../../src/core/rules/condition-interpreter.js')
  const adapter = (ont as unknown as { adapter: { withTenant: (t: string) => unknown } })
    .adapter.withTenant('t1')
  return evaluateRuleCondition(expr as never, inst as never, adapter as never)
}

describe('K11 · default is unchanged', () => {
  it('exists with no direction still means "edges leaving me"', async () => {
    expect(await evaluate(parent, { op: 'exists', relationship: 'commands' })).toBe(true)
    expect(await evaluate(child, { op: 'exists', relationship: 'commands' })).toBe(false)
  })

  it('absent with no direction still means "no edges leaving me"', async () => {
    expect(await evaluate(child, { op: 'absent', relationship: 'commands' })).toBe(true)
  })
})

describe('K11 · direction: in', () => {
  it('sees an edge ARRIVING — the question that could not be asked before', async () => {
    expect(await evaluate(child, { op: 'exists', relationship: 'commands', direction: 'in' }))
      .toBe(true)
    expect(await evaluate(parent, { op: 'exists', relationship: 'commands', direction: 'in' }))
      .toBe(false)
  })

  it('absent reads the same end', async () => {
    expect(await evaluate(orphan, { op: 'absent', relationship: 'commands', direction: 'in' }))
      .toBe(true)
  })
})

describe('K11 · direction: either', () => {
  it('is true at both ends of the edge', async () => {
    for (const id of [parent, child]) {
      expect(await evaluate(id, { op: 'exists', relationship: 'commands', direction: 'either' }))
        .toBe(true)
    }
    expect(await evaluate(orphan, { op: 'exists', relationship: 'commands', direction: 'either' }))
      .toBe(false)
  })

  it('counts a self-edge once, not twice', async () => {
    const solo = (await ont.create('unit', { tag: 'solo' }, prov, ctx)).id
    await ont.link('commands', solo, solo, prov, ctx)
    expect(await evaluate(solo, { op: 'count', relationship: 'commands', direction: 'either', cmp: '=', n: 1 }))
      .toBe(true)
  })
})

describe('K11 · where applies to the FAR end, whichever end that is', () => {
  it('out — the far end is the target', async () => {
    expect(await evaluate(parent, {
      op: 'exists', relationship: 'commands',
      where: { op: 'compare', left: { kind: 'property', entity: 'unit', name: 'tag' }, cmp: '=', right: { kind: 'literal', value: 'child' } },
    })).toBe(true)
  })

  it('in — the far end is the SOURCE, not the target', async () => {
    expect(await evaluate(child, {
      op: 'exists', relationship: 'commands', direction: 'in',
      where: { op: 'compare', left: { kind: 'property', entity: 'unit', name: 'tag' }, cmp: '=', right: { kind: 'literal', value: 'parent' } },
    })).toBe(true)
    // and not the other way round
    expect(await evaluate(child, {
      op: 'exists', relationship: 'commands', direction: 'in',
      where: { op: 'compare', left: { kind: 'property', entity: 'unit', name: 'tag' }, cmp: '=', right: { kind: 'literal', value: 'child' } },
    })).toBe(false)
  })
})

describe('K11 · count honours direction', () => {
  it('counts arriving edges', async () => {
    const second = (await ont.create('unit', { tag: 'p2' }, prov, ctx)).id
    await ont.link('commands', second, child, prov, ctx)
    expect(await evaluate(child, { op: 'count', relationship: 'commands', direction: 'in', cmp: '=', n: 2 }))
      .toBe(true)
  })
})

describe('K11 · a misspelt direction is rejected, not ignored', () => {
  it('throws INVALID_CONDITION_EXPR', async () => {
    const { validateCondition } = await import('../../src/core/rules/condition-interpreter.js')
    let caught: unknown
    try {
      validateCondition({ op: 'exists', relationship: 'commands', direction: 'inward' } as never)
    } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(OntologyError)
    expect((caught as OntologyError).code).toBe('INVALID_CONDITION_EXPR')
  })

  it('accepts the three it knows', async () => {
    const { validateCondition } = await import('../../src/core/rules/condition-interpreter.js')
    for (const direction of ['out', 'in', 'either']) {
      expect(() => validateCondition({ op: 'exists', relationship: 'commands', direction } as never))
        .not.toThrow()
    }
  })
})
