// The same flat `v_*` surface, rebuilt on native tables.
//
// ═══════════════════════════════════════════════════════════════════════════
// ⭐ THE VIEW NAMES AND COLUMN NAMES ARE THE CONTRACT
//
//   A host that already reads through these views (the sane way to read a jsonb
//   store) has its whole read layer written against them — in one production app that
//   is 51 files against 189 views. Storage may change underneath; these names
//   may not. Everything here exists to emit byte-compatible view headers so
//   that switching the store is invisible above this line.
//
//   Two shapes differ from the jsonb generator and both are forced:
//
//   ① `v_rel_*` used to expose the edge row's own `id`. A to-one link is now a
//      foreign key column, and a column has no row identity. The id is
//      synthesised deterministically from (relationship, from_id) so it is
//      stable across rebuilds and across replicas — callers that carry it as a
//      key keep working. It is NOT a real edge id and nothing may write to it.
//
//   ② A to-one link view must skip rows whose FK is NULL, otherwise "no link"
//      would surface as an edge to nowhere.
// ═══════════════════════════════════════════════════════════════════════════
import type { OntologySchema } from '../../types/index.js'
import { PROVENANCE_FIELDS } from '../../types/index.js'
import { assertSafeIdentifier } from './sql.js'
import { joinTableFor, linkPlacement, snake, tableFor } from './native-ddl.js'

const SECURITY_INVOKER = 'WITH (security_invoker = true)'

/** Provenance tail every entity view ends with, in the established order. */
const ENTITY_TAIL = ['source_ref', 'confirmed_by', 'confirmed_at', 'created_at', 'updated_at']
const REL_TAIL = ['source_ref', 'confirmed_by', 'confirmed_at']

/**
 * Deterministic stand-in for the old edge id. `md5(...)::uuid` is a pure
 * function of the pair, so the same link always yields the same id.
 */
const synthId = (relationship: string, fromExpr: string): string =>
  `md5('${relationship}' || ${fromExpr}::text)::uuid AS id`

export function buildNativeViewsSQL(schema: string, ontology: OntologySchema): string[] {
  assertSafeIdentifier(schema, 'buildNativeViewsSQL')
  const q = `"${schema}"`
  const out: string[] = []

  for (const et of ontology.entityTypes) {
    const view = `v_${snake(et.name)}`
    const table = tableFor(et.name)
    // Same reason as native-ddl.ts: the registry appends provenance fields to
    // every type, and this view already selects them in ENTITY_TAIL.
    const business = et.properties.filter(
      (p) => !(PROVENANCE_FIELDS as readonly string[]).includes(p.name),
    )
    const cols = ['id', ...business.map((p) => snake(p.name)), ...ENTITY_TAIL]
    out.push(`DROP VIEW IF EXISTS ${q}.${view} CASCADE`)
    out.push(
      `CREATE VIEW ${q}.${view} ${SECURITY_INVOKER} AS
SELECT
  ${cols.join(',\n  ')}
FROM ${q}.${table}`,
    )
  }

  for (const rel of ontology.relationshipTypes) {
    const view = `v_rel_${snake(rel.name)}`
    const fromCol = `${snake(rel.from)}_id`
    const toCol = `${snake(rel.to)}_id`
    // A self-relationship would collide on the two aliases; disambiguate the
    // second one rather than emit a view Postgres will reject.
    const toAlias = fromCol === toCol ? `${toCol}_2` : toCol
    const place = linkPlacement(rel)
    out.push(`DROP VIEW IF EXISTS ${q}.${view} CASCADE`)

    if (place === null) {
      const table = joinTableFor(rel.name)
      out.push(
        `CREATE VIEW ${q}.${view} ${SECURITY_INVOKER} AS
SELECT
  ${synthId(rel.name, 'from_id')},
  from_id AS ${fromCol},
  to_id AS ${toAlias},
  ${REL_TAIL.join(',\n  ')}
FROM ${q}.${table}`,
      )
      continue
    }

    // To-one link. The row that carries the FK column supplies the provenance —
    // which is what the edge row's provenance already was in 234 of 237 cases
    // measured on the live store.
    const owner = place.table
    const self = place.side === 'from' ? fromCol : toAlias
    const other = place.side === 'from' ? toAlias : fromCol
    out.push(
      `CREATE VIEW ${q}.${view} ${SECURITY_INVOKER} AS
SELECT
  ${synthId(rel.name, 'id')},
  id AS ${self},
  ${place.column} AS ${other},
  ${REL_TAIL.join(',\n  ')}
FROM ${q}.${owner}
WHERE ${place.column} IS NOT NULL`,
    )
  }

  return out
}
