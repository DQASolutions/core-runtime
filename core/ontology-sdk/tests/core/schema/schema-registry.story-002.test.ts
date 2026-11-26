/**
 * DQA:covers=S002-AC-001,S002-AC-002,S002-AC-005,S002-AC-006,S002-AC-007,S002-AC-009,S002-AC-010,S002-AC-011
 * DQA:rule=BR-004
 */
/**
 * STORY-002: Define a RelationshipType with Cardinality and Direction
 *
 * Tests all acceptance criteria and functional requirements for FR-N*, FR-E*, FR-X*, FR-D*.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { SchemaRegistry } from '../../../src/core/schema/schema-registry.js'
import { OntologyError } from '../../../src/types/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry(): SchemaRegistry {
  const reg = new SchemaRegistry()
  // Register two base entity types used across tests
  reg.defineEntityType({ name: 'invoice', label: 'Invoice', properties: [] })
  reg.defineEntityType({ name: 'document', label: 'Document', properties: [] })
  return reg
}

function expectCode(fn: () => unknown, code: string): void {
  let caught: unknown
  try {
    fn()
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(OntologyError)
  expect((caught as OntologyError).code).toBe(code)
}

// ---------------------------------------------------------------------------
// Happy-path tests
// ---------------------------------------------------------------------------

describe('STORY-002: defineRelationshipType — happy path', () => {
  let reg: SchemaRegistry

  beforeEach(() => {
    reg = makeRegistry()
  })

  it('AC-001: stores RelationshipType with all required fields correctly', () => {
    reg.defineRelationshipType({
      name: 'proves',
      from: 'invoice',
      to: 'document',
      cardinality: 'N..1',
      directed: true,
    })
    const schema = reg.getSchema()
    expect(schema.relationshipTypes).toHaveLength(1)
    const rt = schema.relationshipTypes[0]!
    expect(rt.name).toBe('proves')
    expect(rt.from).toBe('invoice')
    expect(rt.to).toBe('document')
    expect(rt.cardinality).toBe('N..1')
    expect(rt.directed).toBe(true)
  })

  it('FR-N04: directed:true stored correctly', () => {
    reg.defineRelationshipType({
      name: 'proves',
      from: 'invoice',
      to: 'document',
      cardinality: '1..N',
      directed: true,
    })
    const rt = reg.getSchema().relationshipTypes[0]!
    expect(rt.directed).toBe(true)
    expect(typeof rt.directed).toBe('boolean')
  })

  it('FR-N04: directed:false stored correctly', () => {
    reg.defineRelationshipType({
      name: 'links',
      from: 'invoice',
      to: 'document',
      cardinality: '1..1',
      directed: false,
    })
    const rt = reg.getSchema().relationshipTypes[0]!
    expect(rt.directed).toBe(false)
    expect(typeof rt.directed).toBe('boolean')
  })

  it('FR-N05: getSchema() returns new entry immediately after defineRelationshipType', () => {
    expect(reg.getSchema().relationshipTypes).toHaveLength(0)
    reg.defineRelationshipType({
      name: 'proves',
      from: 'invoice',
      to: 'document',
      cardinality: 'N..1',
      directed: true,
    })
    expect(reg.getSchema().relationshipTypes).toHaveLength(1)
    expect(reg.getSchema().relationshipTypes[0]!.name).toBe('proves')
  })

  it('FR-N06: optional description stored verbatim', () => {
    const desc = 'Invoice proves a document exists'
    reg.defineRelationshipType({
      name: 'proves',
      from: 'invoice',
      to: 'document',
      cardinality: 'N..1',
      directed: true,
      description: desc,
    })
    const rt = reg.getSchema().relationshipTypes[0]!
    expect(rt.description).toBe(desc)
  })

  it('FR-N06: description absent when not provided', () => {
    reg.defineRelationshipType({
      name: 'proves',
      from: 'invoice',
      to: 'document',
      cardinality: 'N..1',
      directed: true,
    })
    const rt = reg.getSchema().relationshipTypes[0]!
    expect(rt.description).toBeUndefined()
  })

  it('FR-N07 / FR-X01: self-referencing (from === to) is valid', () => {
    expect(() => {
      reg.defineRelationshipType({
        name: 'references',
        from: 'invoice',
        to: 'invoice',
        cardinality: 'N..N',
        directed: true,
      })
    }).not.toThrow()
    const rt = reg.getSchema().relationshipTypes[0]!
    expect(rt.from).toBe('invoice')
    expect(rt.to).toBe('invoice')
  })

  it('FR-X02: directed:false + cardinality:1..1 is valid', () => {
    expect(() => {
      reg.defineRelationshipType({
        name: 'matches',
        from: 'invoice',
        to: 'document',
        cardinality: '1..1',
        directed: false,
      })
    }).not.toThrow()
    const rt = reg.getSchema().relationshipTypes[0]!
    expect(rt.directed).toBe(false)
    expect(rt.cardinality).toBe('1..1')
  })

  it('FR-X03: two RelationshipTypes with same from/to/cardinality but different names — both accepted', () => {
    reg.defineRelationshipType({
      name: 'proves',
      from: 'invoice',
      to: 'document',
      cardinality: 'N..1',
      directed: true,
    })
    reg.defineRelationshipType({
      name: 'supports',
      from: 'invoice',
      to: 'document',
      cardinality: 'N..1',
      directed: true,
    })
    const schema = reg.getSchema()
    expect(schema.relationshipTypes).toHaveLength(2)
    expect(schema.relationshipTypes.map((rt) => rt.name)).toEqual(['proves', 'supports'])
  })

  it('FR-D03: cardinality stored as exact string token (not reformatted)', () => {
    const cardinalities = ['1..1', '1..N', 'N..1', 'N..N'] as const
    for (const cardinality of cardinalities) {
      const r = new SchemaRegistry()
      r.defineEntityType({ name: 'a', label: 'A', properties: [] })
      r.defineEntityType({ name: 'b', label: 'B', properties: [] })
      r.defineRelationshipType({ name: 'rel', from: 'a', to: 'b', cardinality, directed: true })
      expect(r.getSchema().relationshipTypes[0]!.cardinality).toBe(cardinality)
    }
  })

  it('FR-D04: directed stored as native boolean (not 0/1 or string)', () => {
    reg.defineRelationshipType({
      name: 'proves',
      from: 'invoice',
      to: 'document',
      cardinality: 'N..1',
      directed: true,
    })
    const rt = reg.getSchema().relationshipTypes[0]!
    expect(rt.directed).toBe(true)
    expect(typeof rt.directed).toBe('boolean')
  })
})

// ---------------------------------------------------------------------------
// Error-path tests (FR-E01 – FR-E05)
// ---------------------------------------------------------------------------

describe('STORY-002: defineRelationshipType — error paths', () => {
  let reg: SchemaRegistry

  beforeEach(() => {
    reg = makeRegistry()
  })

  it('FR-E01: unknown from EntityType → UNKNOWN_ENTITY_TYPE', () => {
    expectCode(
      () =>
        reg.defineRelationshipType({
          name: 'connects',
          from: 'ghost',
          to: 'document',
          cardinality: '1..N',
          directed: false,
        }),
      'UNKNOWN_ENTITY_TYPE',
    )
  })

  it('AC-002 / FR-E02: unknown to EntityType → UNKNOWN_ENTITY_TYPE', () => {
    expectCode(
      () =>
        reg.defineRelationshipType({
          name: 'connects',
          from: 'invoice',
          to: 'ghost',
          cardinality: '1..N',
          directed: false,
        }),
      'UNKNOWN_ENTITY_TYPE',
    )
  })

  it('FR-E03: duplicate name → UNKNOWN_RELATIONSHIP_TYPE', () => {
    reg.defineRelationshipType({
      name: 'proves',
      from: 'invoice',
      to: 'document',
      cardinality: 'N..1',
      directed: true,
    })
    expectCode(
      () =>
        reg.defineRelationshipType({
          name: 'proves',
          from: 'invoice',
          to: 'document',
          cardinality: '1..1',
          directed: false,
        }),
      'UNKNOWN_RELATIONSHIP_TYPE',
    )
  })

  it('FR-E04: missing name (empty string) → REQUIRED_PROPERTY_MISSING', () => {
    expectCode(
      () =>
        reg.defineRelationshipType({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          name: '' as any,
          from: 'invoice',
          to: 'document',
          cardinality: 'N..1',
          directed: true,
        }),
      'REQUIRED_PROPERTY_MISSING',
    )
  })

  it('FR-E04: missing from (empty string) → REQUIRED_PROPERTY_MISSING', () => {
    expectCode(
      () =>
        reg.defineRelationshipType({
          name: 'proves',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          from: '' as any,
          to: 'document',
          cardinality: 'N..1',
          directed: true,
        }),
      'REQUIRED_PROPERTY_MISSING',
    )
  })

  it('FR-E04: missing to (empty string) → REQUIRED_PROPERTY_MISSING', () => {
    expectCode(
      () =>
        reg.defineRelationshipType({
          name: 'proves',
          from: 'invoice',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          to: '' as any,
          cardinality: 'N..1',
          directed: true,
        }),
      'REQUIRED_PROPERTY_MISSING',
    )
  })

  it('FR-E05: invalid cardinality → TYPE_MISMATCH', () => {
    expectCode(
      () =>
        reg.defineRelationshipType({
          name: 'proves',
          from: 'invoice',
          to: 'document',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          cardinality: 'many-to-one' as any,
          directed: true,
        }),
      'TYPE_MISMATCH',
    )
  })

  it('FR-E05: cardinality "n:n" (wrong format) → TYPE_MISMATCH', () => {
    expectCode(
      () =>
        reg.defineRelationshipType({
          name: 'proves',
          from: 'invoice',
          to: 'document',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          cardinality: 'n:n' as any,
          directed: true,
        }),
      'TYPE_MISMATCH',
    )
  })
})

// ---------------------------------------------------------------------------
// Schema immutability after rejection
// ---------------------------------------------------------------------------

describe('STORY-002: schema unchanged after every rejection', () => {
  let reg: SchemaRegistry

  beforeEach(() => {
    reg = makeRegistry()
  })

  it('schema unchanged after UNKNOWN_ENTITY_TYPE (from)', () => {
    try {
      reg.defineRelationshipType({ name: 'connects', from: 'ghost', to: 'document', cardinality: '1..N', directed: false })
    } catch { /* expected */ }
    expect(reg.getSchema().relationshipTypes).toHaveLength(0)
  })

  it('schema unchanged after UNKNOWN_ENTITY_TYPE (to)', () => {
    try {
      reg.defineRelationshipType({ name: 'connects', from: 'invoice', to: 'ghost', cardinality: '1..N', directed: false })
    } catch { /* expected */ }
    expect(reg.getSchema().relationshipTypes).toHaveLength(0)
  })

  it('schema unchanged after UNKNOWN_RELATIONSHIP_TYPE (duplicate)', () => {
    reg.defineRelationshipType({ name: 'proves', from: 'invoice', to: 'document', cardinality: 'N..1', directed: true })
    try {
      reg.defineRelationshipType({ name: 'proves', from: 'invoice', to: 'document', cardinality: '1..1', directed: false })
    } catch { /* expected */ }
    expect(reg.getSchema().relationshipTypes).toHaveLength(1)
    expect(reg.getSchema().relationshipTypes[0]!.cardinality).toBe('N..1')
  })

  it('schema unchanged after REQUIRED_PROPERTY_MISSING (empty name)', () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reg.defineRelationshipType({ name: '' as any, from: 'invoice', to: 'document', cardinality: 'N..1', directed: true })
    } catch { /* expected */ }
    expect(reg.getSchema().relationshipTypes).toHaveLength(0)
  })

  it('schema unchanged after REQUIRED_PROPERTY_MISSING (empty from)', () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reg.defineRelationshipType({ name: 'proves', from: '' as any, to: 'document', cardinality: 'N..1', directed: true })
    } catch { /* expected */ }
    expect(reg.getSchema().relationshipTypes).toHaveLength(0)
  })

  it('schema unchanged after REQUIRED_PROPERTY_MISSING (empty to)', () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reg.defineRelationshipType({ name: 'proves', from: 'invoice', to: '' as any, cardinality: 'N..1', directed: true })
    } catch { /* expected */ }
    expect(reg.getSchema().relationshipTypes).toHaveLength(0)
  })

  it('schema unchanged after TYPE_MISMATCH (invalid cardinality)', () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reg.defineRelationshipType({ name: 'proves', from: 'invoice', to: 'document', cardinality: 'bad' as any, directed: true })
    } catch { /* expected */ }
    expect(reg.getSchema().relationshipTypes).toHaveLength(0)
  })
})
