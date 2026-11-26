// Native relational DDL from the ontology — one real table per entity type.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY A SECOND STORAGE SHAPE
//
//   The jsonb store (`instances` + `edges`) buys one thing: a new entity type
//   needs no migration. Hosts that author their ontology in a file and ship it
//   with the code never cash that in — their ontology already changes only at
//   deploy time. What they pay instead is measurable:
//
//     · the planner has no statistics for `data->>'x'`, so selectivity comes out
//       ~16x wrong and it picks the wrong index — measured on 1.5M rows
//     · every N..1 link is a row in one shared `edges` table plus two index
//       hops, where a foreign key column would be 16 bytes in the row (14x)
//     · nothing is enforceable: `edges` cannot say that this `rel` only ever
//       joins A to B, so mistyped edges are stored happily
//
//   This module emits the other shape. It changes WHERE the generator writes,
//   not WHO decides: the ontology is still the single source of truth, and the
//   flat `v_*` views stay (see native-views.ts) so the operator surface and any
//   host read layer built on those views keep working unchanged.
//
// ⭐ WHERE A RELATIONSHIP LIVES — derived, never hand-placed
//
//   Cardinality in this SDK constrains edge INSERTION, and that is what decides
//   the storage shape (see PostgresAdapter.insertEdge):
//
//     1..N  →  a source may have at most ONE target   → FK column on FROM table
//     N..1  →  a target may have at most ONE source   → FK column on TO table
//     1..1  →  both                                   → FK column + UNIQUE
//     N..N  →  neither                                → its own join table
//
//   Only N..N keeps a table of its own, and that table carries the four
//   provenance fields, so nothing is lost. For the other three the link becomes
//   a column, and the provenance of the link is the provenance of the row that
//   holds it. When the link itself needs a decision on it ("assigned by order
//   123"), that is not a link — it is an entity, and the ontology should say so.
// ═══════════════════════════════════════════════════════════════════════════
import type { Cardinality, OntologySchema, PropertyType, RelationshipTypeDef } from '../../types/index.js'
import { PROVENANCE_FIELDS } from '../../types/index.js'
import { assertSafeIdentifier } from './sql.js'

/**
 * The registry APPENDS id/source_ref/confirmed_by/confirmed_at to every entity
 * type (NT3), so a schema read back from it carries them as ordinary properties.
 * This module emits those columns itself, from PROVENANCE_DDL — iterating the
 * property list without filtering would declare each of them twice and Postgres
 * rejects the whole CREATE TABLE. Costs one filter; caught by bootstrap, not review.
 */
const isBusinessProperty = (name: string): boolean =>
  !(PROVENANCE_FIELDS as readonly string[]).includes(name)

/** camelCase → snake_case. Same rule the view generator uses, so names line up. */
export const snake = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

/** Table holding one entity type's rows. */
export const tableFor = (entityType: string): string => snake(entityType)

/** Join table for an N..N relationship. */
export const joinTableFor = (relationship: string): string => `rel_${snake(relationship)}`

/** Column holding a to-one link. */
export const fkColumnFor = (relationship: string): string => `${snake(relationship)}_id`

/**
 * Which side of a relationship carries the foreign key column, or null when the
 * relationship needs a join table. Exported because the adapter must resolve
 * the same answer when it reads and writes edges.
 */
export function linkPlacement(
  rel: RelationshipTypeDef,
): { side: 'from' | 'to'; table: string; column: string; references: string; unique: boolean } | null {
  const column = fkColumnFor(rel.name)
  switch (rel.cardinality as Cardinality) {
    case '1..N': // one target per source → column sits on the source row
      return { side: 'from', table: tableFor(rel.from), column, references: tableFor(rel.to), unique: false }
    case '1..1':
      return { side: 'from', table: tableFor(rel.from), column, references: tableFor(rel.to), unique: true }
    case 'N..1': // one source per target → column sits on the target row
      return { side: 'to', table: tableFor(rel.to), column, references: tableFor(rel.from), unique: false }
    case 'N..N':
      return null
    default:
      return null
  }
}

/**
 * Property type → column type.
 *
 * `enum` becomes plain text on purpose. A CHECK constraint would have to be
 * dropped and rebuilt every time the ontology adds an enum value — which the
 * additive-only rule expressly allows — and the SDK already rejects unknown
 * values in validateInstanceData before a write reaches here.
 */
function columnType(type: PropertyType): string {
  switch (type) {
    case 'number':
      return 'numeric'
    case 'date':
      return 'date'
    case 'datetime':
      return 'timestamptz'
    case 'uuid':
      return 'uuid'
    case 'json':
      return 'jsonb'
    case 'text[]':
      return 'text[]'
    case 'text':
    case 'enum':
    case 'file':
    case 'catalogue':
    default:
      return 'text'
  }
}

/** The four provenance columns the SDK injects into every entity type (NT3). */
const PROVENANCE_DDL = [
  'source_ref   text        NOT NULL',
  'confirmed_by text        NOT NULL',
  'confirmed_at timestamptz NOT NULL',
  'created_at   timestamptz NOT NULL DEFAULT now()',
  'updated_at   timestamptz NOT NULL DEFAULT now()',
]

export interface BuildNativeDDLOptions {
  /** Emit CREATE INDEX for these property names wherever they appear. */
  readonly indexed?: readonly string[]
}

/**
 * Full DDL for a schema, in dependency-safe order: every table first, then the
 * foreign keys. Two passes because relationships form cycles — a plain
 * "create table with its FKs inline" ordering cannot exist in general.
 *
 * Every statement is idempotent, so this doubles as the migration path while
 * the ontology stays additive: re-running adds what is missing and touches
 * nothing else.
 */
export function buildNativeDDL(
  schema: string,
  ontology: OntologySchema,
  opts: BuildNativeDDLOptions = {},
): string[] {
  assertSafeIdentifier(schema, 'buildNativeDDL')
  const q = `"${schema}"`
  const out: string[] = [`CREATE SCHEMA IF NOT EXISTS ${q}`]

  // ── id → entity_type, so getInstance(id) works without being told the type ──
  //
  // With one `instances` table the type came back with the row. Across 82 tables
  // an id alone no longer says where to look, and probing every table is not a
  // plan. One narrow index table answers it in a single lookup.
  out.push(
    `CREATE TABLE IF NOT EXISTS ${q}.instance_index (
      id          uuid NOT NULL,
      entity_type text NOT NULL,
      CONSTRAINT pk_instance_index PRIMARY KEY (id)
    )`,
  )

  // ── Pass 1 · one table per entity type ────────────────────────────────────
  for (const et of ontology.entityTypes) {
    const table = tableFor(et.name)
    assertSafeIdentifier(table, 'buildNativeDDL/table')
    const props = et.properties.filter((p) => isBusinessProperty(p.name))
    const cols = props.map((p) => {
      const col = snake(p.name)
      assertSafeIdentifier(col, 'buildNativeDDL/column')
      // NOT NULL is deliberately NOT emitted for required properties: the
      // ontology may add a required property to a type that already has rows,
      // and an additive migration must never fail on existing data. Requiredness
      // is enforced on the write path by validateInstanceData.
      return `${col} ${columnType(p.type)}`
    })
    out.push(
      `CREATE TABLE IF NOT EXISTS ${q}.${table} (
      id uuid NOT NULL,
      ${[...cols, ...PROVENANCE_DDL].join(',\n      ')},
      CONSTRAINT pk_${table} PRIMARY KEY (id)
    )`,
    )
    // Additive path: a property added later shows up here on the next run.
    for (const p of props) {
      out.push(`ALTER TABLE ${q}.${table} ADD COLUMN IF NOT EXISTS ${snake(p.name)} ${columnType(p.type)}`)
    }
    for (const name of opts.indexed ?? []) {
      if (!props.some((p) => p.name === name)) continue
      const col = snake(name)
      out.push(`CREATE INDEX IF NOT EXISTS idx_${table}_${col} ON ${q}.${table} (${col})`)
    }
  }

  // ── Pass 2 · relationships ────────────────────────────────────────────────
  for (const rel of ontology.relationshipTypes) {
    const place = linkPlacement(rel)
    if (place === null) {
      // N..N — its own join table, provenance kept.
      const table = joinTableFor(rel.name)
      assertSafeIdentifier(table, 'buildNativeDDL/joinTable')
      out.push(
        `CREATE TABLE IF NOT EXISTS ${q}.${table} (
      from_id      uuid        NOT NULL REFERENCES ${q}.${tableFor(rel.from)}(id) ON DELETE CASCADE,
      to_id        uuid        NOT NULL REFERENCES ${q}.${tableFor(rel.to)}(id) ON DELETE CASCADE,
      ${PROVENANCE_DDL.join(',\n      ')},
      CONSTRAINT pk_${table} PRIMARY KEY (from_id, to_id)
    )`,
      )
      out.push(`CREATE INDEX IF NOT EXISTS idx_${table}_to ON ${q}.${table} (to_id)`)
      continue
    }
    assertSafeIdentifier(place.column, 'buildNativeDDL/fkColumn')
    // ON DELETE SET NULL, not RESTRICT: with the jsonb store, deleting a row took
    // its edges with it and the other end simply stopped being linked. A column
    // must reproduce that, or a delete that used to succeed starts failing on a
    // foreign key — same data, same intent, new error.
    out.push(`ALTER TABLE ${q}.${place.table} ADD COLUMN IF NOT EXISTS ${place.column} uuid`)
    // Named so a re-run finds it: ADD CONSTRAINT has no IF NOT EXISTS.
    const fk = `fk_${place.table}_${place.column}`
    // DROP rồi ADD, không phải "thêm nếu chưa có". Một ràng buộc đã tồn tại với
    // hành vi xoá KHÁC sẽ không bao giờ được sửa nếu chỉ thêm khi vắng — và nó
    // im lặng cho tới lúc có ai xoá một bản ghi được trỏ tới. Đã dính đúng thế.
    out.push(`ALTER TABLE ${q}.${place.table} DROP CONSTRAINT IF EXISTS ${fk}`)
    out.push(
      `ALTER TABLE ${q}.${place.table}
        ADD CONSTRAINT ${fk} FOREIGN KEY (${place.column})
          REFERENCES ${q}.${place.references}(id) ON DELETE SET NULL`,
    )
    out.push(
      place.unique
        ? `CREATE UNIQUE INDEX IF NOT EXISTS idx_${place.table}_${place.column} ON ${q}.${place.table} (${place.column})`
        : `CREATE INDEX IF NOT EXISTS idx_${place.table}_${place.column} ON ${q}.${place.table} (${place.column})`,
    )
  }

  return out
}
