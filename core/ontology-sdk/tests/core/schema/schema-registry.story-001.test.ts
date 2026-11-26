/**
 * DQA:covers=S001-AC-001,S001-AC-002,S001-AC-005,S001-AC-006,S001-AC-007,S001-AC-009,S001-AC-010,S001-AC-011
 * DQA:rule=BR-003,BR-007
 */
/**
 * STORY-001: Define an EntityType with Auto-Injected Provenance
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
  return new SchemaRegistry()
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

describe('STORY-001: defineEntityType — happy path', () => {
  let reg: SchemaRegistry

  beforeEach(() => {
    reg = makeRegistry()
  })

  it('AC-001 / FR-X01: empty properties → only the 4 injected provenance fields', () => {
    reg.defineEntityType({ name: 'invoice', label: 'Invoice', properties: [] })
    const schema = reg.getSchema()
    expect(schema.entityTypes).toHaveLength(1)
    const et = schema.entityTypes[0]!
    expect(et.name).toBe('invoice')
    expect(et.properties).toHaveLength(4)
    const names = et.properties.map((p) => p.name)
    expect(names).toEqual(['id', 'source_ref', 'confirmed_by', 'confirmed_at'])
  })

  it('AC-001 / FR-D04: caller property appears FIRST, then 4 injected fields', () => {
    reg.defineEntityType({
      name: 'invoice',
      label: 'Invoice',
      properties: [{ name: 'amount', type: 'number', required: true }],
    })
    const et = reg.getSchema().entityTypes[0]!
    expect(et.properties).toHaveLength(5)
    expect(et.properties[0]!.name).toBe('amount')
    expect(et.properties[1]!.name).toBe('id')
    expect(et.properties[2]!.name).toBe('source_ref')
    expect(et.properties[3]!.name).toBe('confirmed_by')
    expect(et.properties[4]!.name).toBe('confirmed_at')
  })

  it('FR-N02: injected id field has type uuid', () => {
    reg.defineEntityType({ name: 'invoice', label: 'Invoice', properties: [] })
    const et = reg.getSchema().entityTypes[0]!
    const id = et.properties.find((p) => p.name === 'id')!
    expect(id.type).toBe('uuid')
    expect(id.required).toBe(true)
  })

  it('FR-N02: injected source_ref field has type text and required=true', () => {
    reg.defineEntityType({ name: 'invoice', label: 'Invoice', properties: [] })
    const et = reg.getSchema().entityTypes[0]!
    const f = et.properties.find((p) => p.name === 'source_ref')!
    expect(f.type).toBe('text')
    expect(f.required).toBe(true)
  })

  it('FR-N02: injected confirmed_by field has type text and required=true', () => {
    reg.defineEntityType({ name: 'invoice', label: 'Invoice', properties: [] })
    const et = reg.getSchema().entityTypes[0]!
    const f = et.properties.find((p) => p.name === 'confirmed_by')!
    expect(f.type).toBe('text')
    expect(f.required).toBe(true)
  })

  it('FR-N02: injected confirmed_at field has type datetime and required=true', () => {
    reg.defineEntityType({ name: 'invoice', label: 'Invoice', properties: [] })
    const et = reg.getSchema().entityTypes[0]!
    const f = et.properties.find((p) => p.name === 'confirmed_at')!
    expect(f.type).toBe('datetime')
    expect(f.required).toBe(true)
  })

  it('FR-N06: getSchema() reflects the new entry after defineEntityType', () => {
    reg.defineEntityType({ name: 'invoice', label: 'Invoice', properties: [] })
    const schema = reg.getSchema()
    expect(schema.entityTypes.some((et) => et.name === 'invoice')).toBe(true)
  })

  it('FR-N07: required defaults to false when absent on a caller property', () => {
    reg.defineEntityType({
      name: 'invoice',
      label: 'Invoice',
      properties: [{ name: 'notes', type: 'text' }],
    })
    const et = reg.getSchema().entityTypes[0]!
    const notes = et.properties.find((p) => p.name === 'notes')!
    // required is absent (undefined / falsy) — default is false per FR-N07
    expect(notes.required ?? false).toBe(false)
  })

  it('FR-N08: description is stored verbatim', () => {
    const desc = 'Total invoice amount in VND'
    reg.defineEntityType({
      name: 'invoice',
      label: 'Invoice',
      properties: [{ name: 'amount', type: 'number', description: desc }],
    })
    const et = reg.getSchema().entityTypes[0]!
    const amount = et.properties.find((p) => p.name === 'amount')!
    expect(amount.description).toBe(desc)
  })

  it('FR-X04: 100 caller properties are accepted without error', () => {
    const properties = Array.from({ length: 100 }, (_, i) => ({
      name: `field${i}`,
      type: 'text' as const,
    }))
    expect(() => {
      reg.defineEntityType({ name: 'bigType', label: 'BigType', properties })
    }).not.toThrow()
    const et = reg.getSchema().entityTypes[0]!
    // 100 caller + 4 injected
    expect(et.properties).toHaveLength(104)
  })
})

// ---------------------------------------------------------------------------
// Error-path tests (FR-E01 – FR-E05)
// ---------------------------------------------------------------------------

describe('STORY-001: defineEntityType — error paths', () => {
  let reg: SchemaRegistry

  beforeEach(() => {
    reg = makeRegistry()
  })

  it('AC-002 / FR-E01: declaring source_ref → PROVENANCE_FIELD_REDECLARED', () => {
    expectCode(
      () =>
        reg.defineEntityType({
          name: 'invoice',
          label: 'Invoice',
          properties: [{ name: 'source_ref', type: 'text' }],
        }),
      'PROVENANCE_FIELD_REDECLARED',
    )
  })

  it('FR-E01: declaring id → PROVENANCE_FIELD_REDECLARED', () => {
    expectCode(
      () =>
        reg.defineEntityType({
          name: 'invoice',
          label: 'Invoice',
          properties: [{ name: 'id', type: 'uuid' }],
        }),
      'PROVENANCE_FIELD_REDECLARED',
    )
  })

  it('FR-E01: declaring confirmed_by → PROVENANCE_FIELD_REDECLARED', () => {
    expectCode(
      () =>
        reg.defineEntityType({
          name: 'invoice',
          label: 'Invoice',
          properties: [{ name: 'confirmed_by', type: 'text' }],
        }),
      'PROVENANCE_FIELD_REDECLARED',
    )
  })

  it('FR-E01: declaring confirmed_at → PROVENANCE_FIELD_REDECLARED', () => {
    expectCode(
      () =>
        reg.defineEntityType({
          name: 'invoice',
          label: 'Invoice',
          properties: [{ name: 'confirmed_at', type: 'datetime' }],
        }),
      'PROVENANCE_FIELD_REDECLARED',
    )
  })

  it('FR-X02: duplicate property name in same def → PROVENANCE_FIELD_REDECLARED', () => {
    expectCode(
      () =>
        reg.defineEntityType({
          name: 'invoice',
          label: 'Invoice',
          properties: [
            { name: 'amount', type: 'number' },
            { name: 'amount', type: 'text' },
          ],
        }),
      'PROVENANCE_FIELD_REDECLARED',
    )
  })

  it('FR-E02: unknown type → UNKNOWN_PROPERTY', () => {
    expectCode(
      () =>
        reg.defineEntityType({
          name: 'invoice',
          label: 'Invoice',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          properties: [{ name: 'amount', type: 'money' as any }],
        }),
      'UNKNOWN_PROPERTY',
    )
  })

  it('FR-E03: enum without enumValues → ENUM_VALUE_INVALID', () => {
    expectCode(
      () =>
        reg.defineEntityType({
          name: 'invoice',
          label: 'Invoice',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          properties: [{ name: 'status', type: 'enum' as any }],
        }),
      'ENUM_VALUE_INVALID',
    )
  })

  it('FR-E03: enum with empty enumValues array → ENUM_VALUE_INVALID', () => {
    expectCode(
      () =>
        reg.defineEntityType({
          name: 'invoice',
          label: 'Invoice',
          properties: [{ name: 'status', type: 'enum', enumValues: [] }],
        }),
      'ENUM_VALUE_INVALID',
    )
  })

  it('FR-E04: same name twice (duplicate entity type) → DUPLICATE_ENTITY_TYPE', () => {
    reg.defineEntityType({ name: 'invoice', label: 'Invoice', properties: [] })
    expectCode(
      () => reg.defineEntityType({ name: 'invoice', label: 'Invoice 2', properties: [] }),
      'DUPLICATE_ENTITY_TYPE',
    )
  })

  it('FR-E05: missing name → REQUIRED_PROPERTY_MISSING', () => {
    expectCode(
      () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        reg.defineEntityType({ name: '' as any, label: 'Invoice', properties: [] }),
      'REQUIRED_PROPERTY_MISSING',
    )
  })

  it('FR-E05: missing label → REQUIRED_PROPERTY_MISSING', () => {
    expectCode(
      () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        reg.defineEntityType({ name: 'invoice', label: '' as any, properties: [] }),
      'REQUIRED_PROPERTY_MISSING',
    )
  })

  it('FR-X03: whitespace-only name → REQUIRED_PROPERTY_MISSING', () => {
    expectCode(
      () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        reg.defineEntityType({ name: '   ' as any, label: 'Invoice', properties: [] }),
      'REQUIRED_PROPERTY_MISSING',
    )
  })
})

// ---------------------------------------------------------------------------
// Schema immutability after rejection
// ---------------------------------------------------------------------------

describe('STORY-001: schema immutability after rejection', () => {
  let reg: SchemaRegistry

  beforeEach(() => {
    reg = makeRegistry()
  })

  it('schema is unchanged after PROVENANCE_FIELD_REDECLARED', () => {
    try {
      reg.defineEntityType({
        name: 'invoice',
        label: 'Invoice',
        properties: [{ name: 'id', type: 'uuid' }],
      })
    } catch {
      // expected
    }
    expect(reg.getSchema().entityTypes).toHaveLength(0)
  })

  it('schema is unchanged after UNKNOWN_PROPERTY', () => {
    try {
      reg.defineEntityType({
        name: 'invoice',
        label: 'Invoice',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        properties: [{ name: 'amount', type: 'money' as any }],
      })
    } catch {
      // expected
    }
    expect(reg.getSchema().entityTypes).toHaveLength(0)
  })

  it('schema is unchanged after ENUM_VALUE_INVALID', () => {
    try {
      reg.defineEntityType({
        name: 'invoice',
        label: 'Invoice',
        properties: [{ name: 'status', type: 'enum', enumValues: [] }],
      })
    } catch {
      // expected
    }
    expect(reg.getSchema().entityTypes).toHaveLength(0)
  })

  it('existing definition is unchanged after DUPLICATE_ENTITY_TYPE', () => {
    reg.defineEntityType({
      name: 'invoice',
      label: 'Invoice',
      properties: [{ name: 'amount', type: 'number' }],
    })
    const before = reg.getSchema().entityTypes[0]!.properties.map((p) => p.name)

    try {
      reg.defineEntityType({ name: 'invoice', label: 'Invoice Modified', properties: [] })
    } catch {
      // expected
    }
    const after = reg.getSchema().entityTypes[0]!.properties.map((p) => p.name)
    expect(after).toEqual(before)
    expect(reg.getSchema().entityTypes).toHaveLength(1)
  })

  it('schema is unchanged after REQUIRED_PROPERTY_MISSING (empty name)', () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      reg.defineEntityType({ name: '' as any, label: 'Invoice', properties: [] })
    } catch {
      // expected
    }
    expect(reg.getSchema().entityTypes).toHaveLength(0)
  })
})
