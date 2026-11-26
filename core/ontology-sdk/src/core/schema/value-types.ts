// VALUE TYPES — a named set of constraints, declared once, pointed at by name.
//
// ═══════════════════════════════════════════════════════════════════════════
// Borrowed from Palantir Foundry's Value Types: "VND amount", "national ID",
// "birth date" are the same rule wherever they appear, so they are declared
// ONCE and every property that holds one says so by name.
//
// Measured on the reference app 12/9/2026: 1 099 of 1 967 properties declared
// no constraint at all, and the ones that did disagreed — one money field with a
// ceiling, the next without; one date with a plausible year range, the next
// taking 20266. Writing bounds property by property is how two money fields end
// up with two definitions of money. A value type makes "đồng đều ở mọi nơi" the
// default rather than a discipline.
//
// ⭐ The property may still NARROW: its own keywords win over the value type's
//    (`maxLength: 12` on a code whose type allows 50). It cannot change the
//    underlying `type` — a value type of `number` on a `text` property is refused.
//
// ⛔ AN UNRESOLVED `valueType` IS REFUSED, NOT IGNORED. `resolveValueTypes`
//    renames it to `valueTypeOf` as it merges; SchemaRegistry rejects any
//    property still carrying `valueType`. Otherwise a caller who forgot to
//    resolve would ship declarations that look right and constrain nothing —
//    the worst kind of declaration, because both sides believe it is done.
// ═══════════════════════════════════════════════════════════════════════════

import { ontologyError, type EntityTypeDef, type PropertyDef, type PropertyType } from '../../types/index.js'
import { constraintDeclarationError } from '../graph/validation.js'

import { VALUE_TYPE_CONSTRAINT_KEYS as CONSTRAINT_KEYS, type ValueTypeDef } from '@dqa-ai-solutions/ontology-base'
export type { ValueTypeDef }

/**
 * Merge each property's `valueType` into its own constraints. Returns new
 * entity definitions; the input is not mutated. Throws INVALID_CONSTRAINT on an
 * unknown value type, a type mismatch, or a value type that is itself
 * meaningless (`maxLength` on a number).
 */
export function resolveValueTypes(entityTypes: EntityTypeDef[], valueTypes: ValueTypeDef[] = []): EntityTypeDef[] {
  const byName = new Map<string, ValueTypeDef>()
  for (const vt of valueTypes) {
    if (byName.has(vt.name)) throw ontologyError('INVALID_CONSTRAINT', `Value type "${vt.name}" is declared twice`)
    const why = constraintDeclarationError({ ...vt } as PropertyDef)
    if (why) throw ontologyError('INVALID_CONSTRAINT', `Value type "${vt.name}": ${why}`)
    byName.set(vt.name, vt)
  }
  return entityTypes.map((et) => ({
    ...et,
    properties: (et.properties ?? []).map((p) => {
      if (p.valueType === undefined) return p
      const vt = byName.get(p.valueType)
      if (!vt) {
        throw ontologyError('INVALID_CONSTRAINT',
          `EntityType "${et.name}" property "${p.name}" names value type "${p.valueType}", which is not declared`,
          { entityType: et.name, property: p.name })
      }
      if (vt.type !== p.type) {
        throw ontologyError('INVALID_CONSTRAINT',
          `EntityType "${et.name}" property "${p.name}" is ${p.type} but value type "${vt.name}" is ${vt.type}`,
          { entityType: et.name, property: p.name })
      }
      const inherited: Record<string, unknown> = {}
      for (const k of CONSTRAINT_KEYS) if (vt[k] !== undefined) inherited[k] = vt[k]
      const { valueType, ...own } = p
      return { ...inherited, ...own, valueTypeOf: valueType } as PropertyDef
    }),
  }))
}
