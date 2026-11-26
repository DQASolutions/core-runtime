// Flat SQL views over the jsonb store — the operator-facing surface.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS IS KERNEL WORK
//
//   Business properties live in `instances.data jsonb`, which means the person
//   who has to answer "why is this record stuck" at 2am cannot use plain SQL.
//   Every app that reaches production therefore writes a generator that turns
//   its ontology into one flat view per entity type — and there is nothing
//   domain-specific in it: entity name, property name, property type. The
//   kernel already holds all three.
//
//   Two details in here are not obvious and were each learned by being wrong:
//   `security_invoker`, and DROP-before-CREATE. Left to each app, each app
//   discovers them separately, and one of them discovers `security_invoker`
//   in production.
// ═══════════════════════════════════════════════════════════════════════════

import type { OntologySchema, PropertyType } from '../../types/index.js'
import { assertSafeIdentifier } from './sql.js'

export interface BuildViewsOptions {
  /**
   * Schema the views are created in. Defaults to the literal `:schema`, so the
   * output is a file that can be applied to many tenant schemas by substitution.
   */
  schema?: string
  /**
   * Property names worth an expression index — the ones queries filter on.
   *
   * Which properties are hot is the app's knowledge, not the kernel's, so there
   * is no default list: without indexes every filtered read is a full scan of
   * the tenant's instances, and the kernel is not in a position to guess which
   * columns matter.
   */
  indexed?: readonly string[]
}

/** snake_case for SQL identifiers — camelCase is hostile to people writing SQL by hand. */
const snake = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()

/**
 * ⚠️ `security_invoker = true` is REQUIRED, not a preference.
 *
 * A view runs with the privileges of its OWNER by default. These views are
 * created by the table owner, and the table owner BYPASSES row-level security —
 * so reading through the view would return every tenant's rows even when the
 * application connects as a restricted role with its scope correctly set. The
 * view would quietly become a hole straight through row-level security.
 *
 * Requires PostgreSQL 15 or later.
 */
const SECURITY_INVOKER = 'WITH (security_invoker = true)'

/** Cast a jsonb extraction to the Postgres type, so ordering and comparison work. */
function cast(type: PropertyType, expr: string): string {
  switch (type) {
    case 'number': return `(${expr})::numeric`
    case 'date': return `(${expr})::date`
    case 'datetime': return `(${expr})::timestamptz`
    case 'uuid': return `(${expr})::uuid`
    case 'json': return expr.replace('->>', '->')
    default: return expr // text, enum, and anything textual
  }
}

/**
 * One flat view per entity type and per relationship type, plus expression
 * indexes for the properties named in `indexed`.
 *
 * Returns statements in application order. Re-runnable: every view is dropped
 * before it is recreated.
 */
export function buildViewsDDL(schema: OntologySchema, opts: BuildViewsOptions = {}): string[] {
  const s = opts.schema ?? ':schema'
  // The placeholder is not an identifier, so it is exempt; anything else is checked.
  if (s !== ':schema') assertSafeIdentifier(s, 'buildViewsDDL')

  const out: string[] = []

  for (const et of schema.entityTypes) {
    const columns = (et.properties ?? [])
      // Provenance columns are real columns on the table, not jsonb keys; the
      // SDK appends them to every entity type, and selecting them out of `data`
      // would produce a column of nulls beside the real one.
      .filter((p) => !PROVENANCE.has(p.name))
      .map((p) => `  ${cast(p.type, `i.data->>'${p.name}'`)} AS ${snake(p.name)}`)

    // ⚠️ DROP … CASCADE before CREATE, not CREATE OR REPLACE.
    //    Replace refuses to change a column's NAME or drop one, so the first
    //    time a property is renamed the migration fails with "cannot change
    //    name of view column" — at which point the schema and the views have
    //    already diverged.
    out.push(`DROP VIEW IF EXISTS ${s}.v_${snake(et.name)} CASCADE;`)
    out.push(
      `CREATE VIEW ${s}.v_${snake(et.name)} ${SECURITY_INVOKER} AS\n` +
        'SELECT\n' +
        '  i.id,\n' +
        (columns.length > 0 ? `${columns.join(',\n')},\n` : '') +
        '  i.source_ref,\n' +
        '  i.confirmed_by,\n' +
        '  i.confirmed_at,\n' +
        '  i.created_at,\n' +
        '  i.updated_at\n' +
        `FROM ${s}.instances i\n` +
        `WHERE i.entity_type = '${et.name}';`,
    )
  }

  for (const rt of schema.relationshipTypes) {
    // A relationship whose two ends are the SAME entity type — a tree: a unit
    // inside a unit, a target broken out of a target — would name both columns
    // after that one type, and Postgres refuses the view outright:
    // `column "..." specified more than once`. The native generator has always
    // disambiguated; this one did not, so every self-referencing relationship
    // produced a view that could not be created. Same rule, same suffix.
    const fromCol = `${snake(rt.from)}_id`
    const toCol = rt.from === rt.to ? `${snake(rt.to)}_id_2` : `${snake(rt.to)}_id`
    out.push(`DROP VIEW IF EXISTS ${s}.v_rel_${snake(rt.name)} CASCADE;`)
    out.push(
      `CREATE VIEW ${s}.v_rel_${snake(rt.name)} ${SECURITY_INVOKER} AS\n` +
        'SELECT\n' +
        '  e.id,\n' +
        `  e.from_id AS ${fromCol},\n` +
        `  e.to_id AS ${toCol},\n` +
        '  e.source_ref,\n' +
        '  e.confirmed_by,\n' +
        '  e.confirmed_at\n' +
        `FROM ${s}.edges e\n` +
        `WHERE e.rel = '${rt.name}';`,
    )
  }

  const hot = new Set(opts.indexed ?? [])
  for (const et of schema.entityTypes) {
    for (const p of et.properties ?? []) {
      if (!hot.has(p.name)) continue
      out.push(
        `CREATE INDEX IF NOT EXISTS idx_${snake(et.name)}_${snake(p.name)}\n` +
          `  ON ${s}.instances ((data->>'${p.name}'))\n` +
          `  WHERE entity_type = '${et.name}';`,
      )
    }
  }

  return out
}

/** The same statements as one applyable file, with a do-not-edit header. */
export function buildViewsSQL(schema: OntologySchema, opts: BuildViewsOptions = {}): string {
  const header = [
    '-- GENERATED from the ontology by @dqa-ai-solutions/ontology-sdk — DO NOT EDIT BY HAND.',
    '-- Operator surface: plain SQL over the jsonb store, no knowledge of jsonb needed.',
    '-- Regenerate whenever the ontology changes.',
    opts.schema === undefined
      ? '-- Substitute :schema with the tenant schema, e.g. t_acme.'
      : null,
    '',
  ].filter((l): l is string => l !== null)
  return [...header, ...buildViewsDDL(schema, opts), ''].join('\n')
}

/** Provenance lives in real columns; the SDK appends these to every entity type. */
const PROVENANCE = new Set(['source_ref', 'confirmed_by', 'confirmed_at', 'created_at', 'updated_at'])
