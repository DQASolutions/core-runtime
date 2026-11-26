// Ontology Schema context (Layer 2). The validation authority for entity &
// relationship type definitions. One registry per tenant (schema is per-tenant).
// Auto-injects provenance conceptually (NT3): callers must NOT declare the four
// provenance fields, and the SDK always treats every instance as carrying them.

import {
  type EntityTypeDef,
  type OntologySchema,
  type PropertyDef,
  type PropertyType,
  type RelationshipTypeDef,
  PROVENANCE_FIELDS,
  ontologyError,
} from '../../types/index.js'
import { constraintDeclarationError } from '../graph/validation.js'

const VALID_PROPERTY_TYPES: ReadonlySet<PropertyType> = new Set<PropertyType>([
  'text',
  'number',
  'date',
  'datetime',
  'enum',
  'uuid',
  'json',
  'text[]',
  'file',
  'catalogue',
])

const VALID_CARDINALITIES = new Set(['1..1', '1..N', 'N..1', 'N..N'])

// Safe identifier charset (security-requirements SR — prevents identifier
// injection when a name is later used to derive a SQL identifier).
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/

function assertSafeName(kind: string, name: unknown): asserts name is string {
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw ontologyError('REQUIRED_PROPERTY_MISSING', `${kind} name is required and must be non-empty`)
  }
  if (!SAFE_NAME.test(name)) {
    throw ontologyError(
      'INVALID_NAME',
      `${kind} name "${name}" is not a safe identifier (must match ${SAFE_NAME})`,
    )
  }
}

export class SchemaRegistry {
  private readonly entityTypes = new Map<string, EntityTypeDef>()
  private readonly relationshipTypes = new Map<string, RelationshipTypeDef>()

  // @impl BR-002, BR-003, S001-AC-001, S001-AC-005, S001-AC-006, S001-AC-010
  defineEntityType(def: EntityTypeDef): void {
    assertSafeName('EntityType', def.name)
    if (typeof def.label !== 'string' || def.label.trim().length === 0) {
      throw ontologyError('REQUIRED_PROPERTY_MISSING', `EntityType "${def.name}" label is required`)
    }
    if (this.entityTypes.has(def.name)) {
      throw ontologyError('DUPLICATE_ENTITY_TYPE', `EntityType "${def.name}" already defined`)
    }
    // @impl S001-AC-002, S001-AC-009, S001-AC-011
    const seen = new Set<string>()
    // @impl S001-AC-002, S001-AC-009, S001-AC-011
    for (const p of def.properties ?? []) {
      this.validateProperty(def.name, p)
      if (PROVENANCE_FIELDS.includes(p.name as never)) {
        throw ontologyError(
          'PROVENANCE_FIELD_REDECLARED',
          `EntityType "${def.name}" must not declare provenance field "${p.name}" — the SDK injects it (NT3)`,
        )
      }
      if (seen.has(p.name)) {
        throw ontologyError(
          'PROVENANCE_FIELD_REDECLARED',
          `EntityType "${def.name}" declares duplicate property "${p.name}"`,
        )
      }
      seen.add(p.name)
    }
    // @impl S001-AC-007
    // Store a defensive copy with provenance fields appended (FR-D04, FR-N02).
    // @impl S001-AC-007
    const provenanceProps: PropertyDef[] = [
      { name: 'id', type: 'uuid', required: true },
      // @impl S001-AC-007
      { name: 'source_ref', type: 'text', required: true },
      { name: 'confirmed_by', type: 'text', required: true },
      { name: 'confirmed_at', type: 'datetime', required: true },
    ]
    this.entityTypes.set(def.name, {
      ...def,
      properties: [...(def.properties ?? []), ...provenanceProps],
    // @impl BR-007
    })
  // @impl BR-007
  }

  // @impl BR-007
  private validateProperty(entityName: string, p: PropertyDef): void {
    assertSafeName(`EntityType "${entityName}" property`, p.name)
    if (!VALID_PROPERTY_TYPES.has(p.type)) {
      throw ontologyError('UNKNOWN_PROPERTY', `Property "${p.name}" has unknown type "${p.type}"`)
    }
    if (p.type === 'enum') {
      if (!Array.isArray(p.enumValues) || p.enumValues.length === 0) {
        // @impl S002-AC-001, S002-AC-002, S002-AC-005, S002-AC-006, S002-AC-007, S002-AC-009, S002-AC-010, S002-AC-011
        throw ontologyError(
          'ENUM_VALUE_INVALID',
          // @impl S002-AC-001, S002-AC-002, S002-AC-005, S002-AC-006, S002-AC-007, S002-AC-009, S002-AC-010, S002-AC-011
          `Enum property "${p.name}" must declare a non-empty enumValues array`,
        )
      }
    }
    // A catalogue property without a collection name is a text field wearing a
    // costume: nothing downstream can find the rows, so nothing can offer the
    // choices or check the key. Refuse it at declaration time, the same way an
    // enum without values is refused.
    if (p.type === 'catalogue') {
      if (typeof p.catalogue !== 'string' || p.catalogue.trim().length === 0) {
        throw ontologyError(
          'ENUM_VALUE_INVALID',
          `Catalogue property "${p.name}" must declare the collection it draws from (catalogue: "...")`,
        )
      }
      assertSafeName(`EntityType "${entityName}" property "${p.name}" catalogue`, p.catalogue)
    // @impl S002-AC-001, S002-AC-002, S002-AC-005, S002-AC-006, S002-AC-007, S002-AC-009, S002-AC-010, S002-AC-011
    }
    // A `valueType` still here was never merged — its constraints would apply
    // to nothing while the declaration looks done. See value-types.ts.
    if (p.valueType !== undefined) {
      throw ontologyError('INVALID_CONSTRAINT',
        `EntityType "${entityName}" property "${p.name}" names value type "${p.valueType}" that was never resolved — `
        + 'pass the entity types through resolveValueTypes() first, or its constraints apply to nothing',
        { entityType: entityName, property: p.name })
    }
    // A constraint that cannot mean anything — `maxLength` on a number, a
    // `minimum` above the `maximum`, a pattern that does not compile — would
    // otherwise constrain nothing, silently. Refuse it where it is written.
    const why = constraintDeclarationError(p)
    if (why) {
      throw ontologyError('INVALID_CONSTRAINT', `EntityType "${entityName}" property "${p.name}": ${why}`, {
        entityType: entityName,
        property: p.name,
      })
    }
  }

  // @impl S002-AC-001, S002-AC-002, S002-AC-005, S002-AC-006, S002-AC-007, S002-AC-009, S002-AC-010, S002-AC-011
  defineRelationshipType(def: RelationshipTypeDef): void {
    // FR-E04: name, from, and to must be non-empty strings
    assertSafeName('RelationshipType', def.name)
    if (typeof def.from !== 'string' || def.from.trim().length === 0) {
      throw ontologyError('REQUIRED_PROPERTY_MISSING', `RelationshipType "${def.name}" from is required and must be non-empty`)
    // @impl BR-004
    }
    if (typeof def.to !== 'string' || def.to.trim().length === 0) {
      throw ontologyError('REQUIRED_PROPERTY_MISSING', `RelationshipType "${def.name}" to is required and must be non-empty`)
    // @impl BR-004
    }
    // FR-E03: duplicate name → UNKNOWN_RELATIONSHIP_TYPE (duplicate-detection signal per FR-N10)
    if (this.relationshipTypes.has(def.name)) {
      throw ontologyError(
        // @impl BR-004
        'UNKNOWN_RELATIONSHIP_TYPE',
        `RelationshipType "${def.name}" already defined`,
      )
    }
    // FR-E01/FR-E02: from/to must reference known EntityTypes
    if (!this.entityTypes.has(def.from)) {
      throw ontologyError(
        'UNKNOWN_ENTITY_TYPE',
        `RelationshipType "${def.name}" references unknown from-type "${def.from}"`,
      )
    }
    if (!this.entityTypes.has(def.to)) {
      throw ontologyError(
        'UNKNOWN_ENTITY_TYPE',
        `RelationshipType "${def.name}" references unknown to-type "${def.to}"`,
      )
    }
    // FR-E05: invalid cardinality → TYPE_MISMATCH
    if (!VALID_CARDINALITIES.has(def.cardinality)) {
      throw ontologyError(
        'TYPE_MISMATCH',
        `RelationshipType "${def.name}" has invalid cardinality "${def.cardinality}"`,
      )
    }
    // `directed` decides which end a traversal may walk from. Left out, it read as
    // falsy — an UNDIRECTED edge — without a word, while every declaration in use
    // meant the opposite. Say it, either way.
    if (typeof def.directed !== 'boolean') {
      throw ontologyError(
        'TYPE_MISMATCH',
        `RelationshipType "${def.name}" must say whether it is directed (directed: true | false), got ${JSON.stringify(def.directed)}`,
      )
    }
    this.relationshipTypes.set(def.name, { ...def })
  }

  getEntityType(name: string): EntityTypeDef | undefined {
    return this.entityTypes.get(name)
  }

  requireEntityType(name: string): EntityTypeDef {
    const et = this.entityTypes.get(name)
    if (!et) throw ontologyError('UNKNOWN_ENTITY_TYPE', `Unknown EntityType "${name}"`)
    return et
  }

  getRelationshipType(name: string): RelationshipTypeDef | undefined {
    return this.relationshipTypes.get(name)
  }

  requireRelationshipType(name: string): RelationshipTypeDef {
    const rt = this.relationshipTypes.get(name)
    if (!rt) throw ontologyError('UNKNOWN_RELATIONSHIP_TYPE', `Unknown RelationshipType "${name}"`)
    return rt
  }

  getSchema(): OntologySchema {
    return {
      entityTypes: [...this.entityTypes.values()],
      relationshipTypes: [...this.relationshipTypes.values()],
    }
  }
}
