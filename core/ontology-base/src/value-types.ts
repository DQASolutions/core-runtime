// Value type — a named set of constraints, declared once, pointed at by name
// (a property says `valueType: <name>`). Resolution lives in the SDK
// (`resolveValueTypes`); this is only the shape.

import type { PropertyDef, PropertyType } from './concepts.js'

export const VALUE_TYPE_CONSTRAINT_KEYS = [
  'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf',
  'minItems', 'maxItems', 'formatMinimum', 'formatMaximum',
  'accept', 'maxBytes',
] as const

export type ValueTypeDef = {
  name: string
  type: PropertyType
  description?: string
} & Pick<PropertyDef, (typeof VALUE_TYPE_CONSTRAINT_KEYS)[number]>
