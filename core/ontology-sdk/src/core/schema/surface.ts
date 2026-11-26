// The ADDITIVE-ONLY guarantee: what an already-written event may depend on, and
// what it means to break it.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHY THIS IS KERNEL WORK
//
//   Replay is the kernel's mechanism. An event written last month is decoded
//   with today's ontology, so renaming a property or narrowing a type does not
//   just change the schema — it makes stored events undecodable, and only for
//   the ones nobody has replayed yet. The damage surfaces late, far from the
//   commit that caused it, and usually at the least connected node.
//
//   Left to each app this becomes a convention, and a convention that has
//   already been broken twice in a downstream project — both times for a good
//   reason, both times while the property was still empty. "Good reason" is
//   something anyone can always talk themselves into, which is exactly why the
//   check belongs where the guarantee is made.
//
//   What stays with the app: WHERE to keep the baseline. The kernel says what
//   counts as breaking; the app says which snapshot to compare against.
// ═══════════════════════════════════════════════════════════════════════════

import type { OntologySchema, PropertyType, Cardinality } from '../../types/index.js'

/** The part of a schema an already-written event can depend on. */
export interface SchemaSurface {
  entities: Record<string, Record<string, { type: PropertyType; enumValues: string[] | null; catalogue?: string }>>
  relationships: Record<string, { from: string; to: string; cardinality: Cardinality }>
}

export interface BreakingChange {
  kind:
    | 'ENTITY_REMOVED'
    | 'PROPERTY_REMOVED'
    | 'PROPERTY_TYPE_CHANGED'
    | 'ENUM_VALUE_REMOVED'
    | 'CATALOGUE_CHANGED'
    | 'RELATIONSHIP_REMOVED'
    | 'RELATIONSHIP_ENDPOINT_CHANGED'
    | 'RELATIONSHIP_CARDINALITY_CHANGED'
  /** Dotted path to what changed, e.g. `Citizen.dateOfBirth`. */
  at: string
  detail: string
}

/**
 * Reduce a schema to the surface an event can depend on.
 *
 * Labels, descriptions and property ORDER are deliberately excluded: changing
 * them cannot make a stored event undecodable, and a check that fires on a
 * re-worded label is a check people learn to skip.
 */
export function schemaSurface(schema: OntologySchema): SchemaSurface {
  const entities: SchemaSurface['entities'] = {}
  for (const et of schema.entityTypes) {
    const props: Record<string, { type: PropertyType; enumValues: string[] | null; catalogue?: string }> = {}
    for (const p of et.properties ?? []) {
      const values = (p as { enumValues?: string[] }).enumValues
      // The catalogue NAME is surface; the catalogue's CONTENTS are not. That
      // is the whole bargain of the type: rows may come and go without a schema
      // change, but repointing a property at a different collection can orphan
      // every key already stored — so the name has to be watched.
      const catalogue = (p as { catalogue?: string }).catalogue
      props[p.name] = {
        type: p.type,
        enumValues: Array.isArray(values) ? [...values].sort() : null,
        ...(catalogue !== undefined ? { catalogue } : {}),
      }
    }
    entities[et.name] = props
  }

  const relationships: SchemaSurface['relationships'] = {}
  for (const rt of schema.relationshipTypes) {
    relationships[rt.name] = { from: rt.from, to: rt.to, cardinality: rt.cardinality }
  }

  return { entities, relationships }
}

/**
 * Every change from `before` to `after` that an already-written event could
 * trip over. Additions return an empty list — that is the whole point.
 *
 * ⚠️ A rename is reported as a REMOVE plus an addition, and the remove is what
 *    fails. That is not a limitation to work around: a rename and a
 *    remove-then-add are indistinguishable to stored data, and both leave old
 *    events pointing at a name that is gone.
 */
export function breakingChanges(before: SchemaSurface, after: SchemaSurface): BreakingChange[] {
  const out: BreakingChange[] = []

  for (const [entity, props] of Object.entries(before.entities)) {
    const now = after.entities[entity]
    if (now === undefined) {
      out.push({
        kind: 'ENTITY_REMOVED',
        at: entity,
        detail: `EntityType "${entity}" is gone; events referring to it can no longer be decoded.`,
      })
      continue
    }
    for (const [prop, was] of Object.entries(props)) {
      const is = now[prop]
      if (is === undefined) {
        out.push({
          kind: 'PROPERTY_REMOVED',
          at: `${entity}.${prop}`,
          detail: `Property "${prop}" is gone (renamed counts as gone).`,
        })
        continue
      }
      if (is.type !== was.type) {
        out.push({
          kind: 'PROPERTY_TYPE_CHANGED',
          at: `${entity}.${prop}`,
          detail: `Type changed ${was.type} → ${is.type}; stored values may no longer parse.`,
        })
      }
      // Repointing a property at another catalogue orphans every key already
      // stored under the old one — the same harm as removing an enum value,
      // arriving by a different door.
      if (was.catalogue !== undefined && is.catalogue !== was.catalogue) {
        out.push({
          kind: 'CATALOGUE_CHANGED',
          at: `${entity}.${prop}`,
          detail: `Catalogue changed "${was.catalogue}" → "${is.catalogue ?? '(none)'}"; stored keys may not exist in the new collection.`,
        })
      }
      // Adding an enum value is fine; removing one orphans records already holding it.
      for (const value of was.enumValues ?? []) {
        if (!(is.enumValues ?? []).includes(value)) {
          out.push({
            kind: 'ENUM_VALUE_REMOVED',
            at: `${entity}.${prop}`,
            detail: `Enum value "${value}" removed; records already holding it become invalid.`,
          })
        }
      }
    }
  }

  for (const [name, was] of Object.entries(before.relationships)) {
    const is = after.relationships[name]
    if (is === undefined) {
      out.push({
        kind: 'RELATIONSHIP_REMOVED',
        at: name,
        detail: `RelationshipType "${name}" is gone; edges written under it are orphaned.`,
      })
      continue
    }
    if (is.from !== was.from || is.to !== was.to) {
      out.push({
        kind: 'RELATIONSHIP_ENDPOINT_CHANGED',
        at: name,
        detail: `Endpoints changed ${was.from}→${was.to} into ${is.from}→${is.to}; existing edges now join the wrong types.`,
      })
    }
    if (is.cardinality !== was.cardinality) {
      out.push({
        kind: 'RELATIONSHIP_CARDINALITY_CHANGED',
        at: name,
        detail: `Cardinality changed ${was.cardinality} → ${is.cardinality}; edges that were legal may not be.`,
      })
    }
  }

  return out
}

/** One readable block per breaking change — for an error a person has to act on. */
export function formatBreakingChanges(changes: readonly BreakingChange[]): string {
  return changes.map((c) => `  ⛔ ${c.kind} at ${c.at}\n     ${c.detail}`).join('\n')
}
