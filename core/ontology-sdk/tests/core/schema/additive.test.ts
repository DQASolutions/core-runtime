/**
 * K5 — the additive-only guarantee, owned by the kernel.
 *
 * Replay decodes an old event with today's ontology, so a rename or a narrowed
 * type does not merely change the schema: it strands events nobody has replayed
 * yet, and the damage shows up late and far from the commit that caused it.
 * The kernel defines what counts as breaking; the app only says which snapshot
 * to compare against.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  createOntology, InMemoryAdapter, OntologyError,
  schemaSurface, breakingChanges,
  type Ontology, type SchemaSurface,
} from '../../../src/index.js'

const ctx = { tenantId: 't1' }

const base = (): SchemaSurface => ({
  entities: {
    Citizen: {
      nationalId: { type: 'text', enumValues: null },
      dateOfBirth: { type: 'date', enumValues: null },
      gender: { type: 'enum', enumValues: ['female', 'male'] },
    },
  },
  relationships: {
    livesIn: { from: 'Citizen', to: 'Commune', cardinality: 'N..1' },
  },
})

/** Deep clone so a test can mutate one corner without touching the others. */
const variant = (edit: (s: SchemaSurface) => void): SchemaSurface => {
  const s = JSON.parse(JSON.stringify(base())) as SchemaSurface
  edit(s)
  return s
}

describe('K5 · additions are not breaking', () => {
  it('a new entity', () => {
    const after = variant((s) => { s.entities['Unit'] = { name: { type: 'text', enumValues: null } } })
    expect(breakingChanges(base(), after)).toEqual([])
  })

  it('a new property', () => {
    const after = variant((s) => { s.entities['Citizen']!['hamlet'] = { type: 'text', enumValues: null } })
    expect(breakingChanges(base(), after)).toEqual([])
  })

  it('a new enum value', () => {
    const after = variant((s) => { s.entities['Citizen']!['gender']!.enumValues = ['female', 'male', 'other'] })
    expect(breakingChanges(base(), after)).toEqual([])
  })

  it('a new relationship', () => {
    const after = variant((s) => { s.relationships['worksAt'] = { from: 'Citizen', to: 'Unit', cardinality: 'N..1' } })
    expect(breakingChanges(base(), after)).toEqual([])
  })

  it('an unchanged schema', () => {
    expect(breakingChanges(base(), base())).toEqual([])
  })
})

describe('K5 · what strands a stored event', () => {
  const only = (after: SchemaSurface) => breakingChanges(base(), after).map((c) => c.kind)

  it('removing an entity', () => {
    expect(only(variant((s) => { delete s.entities['Citizen'] }))).toEqual(['ENTITY_REMOVED'])
  })

  it('removing a property', () => {
    expect(only(variant((s) => { delete s.entities['Citizen']!['dateOfBirth'] })))
      .toEqual(['PROPERTY_REMOVED'])
  })

  it('renaming a property — indistinguishable from removing it, and just as fatal', () => {
    const after = variant((s) => {
      delete s.entities['Citizen']!['dateOfBirth']
      s.entities['Citizen']!['birthDate'] = { type: 'date', enumValues: null }
    })
    expect(only(after)).toEqual(['PROPERTY_REMOVED'])
  })

  it('changing a property type', () => {
    expect(only(variant((s) => { s.entities['Citizen']!['dateOfBirth']!.type = 'text' })))
      .toEqual(['PROPERTY_TYPE_CHANGED'])
  })

  it('removing an enum value', () => {
    expect(only(variant((s) => { s.entities['Citizen']!['gender']!.enumValues = ['male'] })))
      .toEqual(['ENUM_VALUE_REMOVED'])
  })

  it('removing a relationship', () => {
    expect(only(variant((s) => { delete s.relationships['livesIn'] })))
      .toEqual(['RELATIONSHIP_REMOVED'])
  })

  it('moving a relationship endpoint', () => {
    expect(only(variant((s) => { s.relationships['livesIn']!.to = 'Province' })))
      .toEqual(['RELATIONSHIP_ENDPOINT_CHANGED'])
  })

  it('changing cardinality', () => {
    expect(only(variant((s) => { s.relationships['livesIn']!.cardinality = 'N..N' })))
      .toEqual(['RELATIONSHIP_CARDINALITY_CHANGED'])
  })

  it('names WHERE, so the message points at something', () => {
    const [change] = breakingChanges(base(), variant((s) => { delete s.entities['Citizen']!['dateOfBirth'] }))
    expect(change!.at).toBe('Citizen.dateOfBirth')
  })
})

describe('K5 · labels and order are not part of the surface', () => {
  it('property order does not matter', () => {
    const reordered: SchemaSurface = {
      entities: {
        Citizen: {
          gender: { type: 'enum', enumValues: ['female', 'male'] },
          nationalId: { type: 'text', enumValues: null },
          dateOfBirth: { type: 'date', enumValues: null },
        },
      },
      relationships: base().relationships,
    }
    expect(breakingChanges(base(), reordered)).toEqual([])
  })

  it('enum value order does not matter', () => {
    const after = variant((s) => { s.entities['Citizen']!['gender']!.enumValues = ['male', 'female'] })
    expect(breakingChanges(base(), after)).toEqual([])
  })
})

describe('K5 · migrate() enforces it', () => {
  let ont: Ontology

  beforeEach(async () => {
    ont = createOntology({ adapter: new InMemoryAdapter() })
    await ont.defineEntityType(
      { name: 'doc', label: 'Doc', properties: [{ name: 'title', type: 'text' }] },
      ctx,
    )
  })

  it('with no baseline it behaves exactly as before', async () => {
    await expect(ont.migrate(ctx)).resolves.toBeDefined()
  })

  it('accepts an additive change against a baseline', async () => {
    const before = schemaSurface(await ont.getSchema(ctx))
    await ont.defineEntityType({ name: 'note', label: 'Note', properties: [] }, ctx)
    await expect(ont.migrate(ctx, { baseline: before })).resolves.toBeDefined()
  })

  it('refuses a removal, and says what would break', async () => {
    const before = schemaSurface(await ont.getSchema(ctx))
    // A fresh registry standing in for "someone deleted the entity".
    const next = createOntology({ adapter: new InMemoryAdapter() })
    await next.defineEntityType({ name: 'note', label: 'Note', properties: [] }, ctx)

    let caught: unknown
    try { await next.migrate(ctx, { baseline: before }) } catch (e) { caught = e }

    expect(caught).toBeInstanceOf(OntologyError)
    expect((caught as OntologyError).code).toBe('BREAKING_SCHEMA_CHANGE')
    expect((caught as Error).message).toContain('ENTITY_REMOVED')
    expect((caught as Error).message).toContain('doc')
  })

  it('acceptBreaking lets it through — deliberately, per call', async () => {
    const before = schemaSurface(await ont.getSchema(ctx))
    const next = createOntology({ adapter: new InMemoryAdapter() })
    await next.defineEntityType({ name: 'note', label: 'Note', properties: [] }, ctx)
    await expect(next.migrate(ctx, { baseline: before, acceptBreaking: true }))
      .resolves.toBeDefined()
  })

  it('refuses BEFORE touching the adapter — no half-applied schema', async () => {
    const before = schemaSurface(await ont.getSchema(ctx))
    let applied = false
    const adapter = new InMemoryAdapter()
    const spy = new Proxy(adapter, {
      get(t, p, r) {
        if (p === 'applySchema') return () => { applied = true; return Promise.resolve({ changes: [] }) }
        if (p === 'withTenant') return () => spy
        return Reflect.get(t, p, r)
      },
    })
    const next = createOntology({ adapter: spy as never })
    await next.defineEntityType({ name: 'note', label: 'Note', properties: [] }, ctx)

    await expect(next.migrate(ctx, { baseline: before })).rejects.toThrow()
    expect(applied).toBe(false)
  })
})
