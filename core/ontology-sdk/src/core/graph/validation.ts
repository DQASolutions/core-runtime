// Instance Graph context (Layer 2) — property-bag validation against the
// EntityType definition. Runs before any storage write. BR-007.
//
// ═══════════════════════════════════════════════════════════════════════════
// ⭐ STRICT, NOT LENIENT — rewritten 12/9/2026 after feeding it junk.
//
//   The first version asked one question per type: "is it roughly the right
//   JavaScript type?" 33 kinds of junk were fed to it; 30 were stored. The worst:
//
//     · `date` used `Date.parse`, which GUESSES. `"1"` → 2001-01-01, `"hello 2"`
//       → 2001-02-01, `"2026-02-31"` → 2026-03-03. A typo became a real date.
//     · `text` had no ceiling and no character check — five million characters
//       went in, and so did U+0000, which Postgres cannot store: a bare 500.
//     · `required` text took `"   "` — present to the guard, empty to a person.
//     · `number` took 1e300 and 2^53 + 1, which a JS number cannot hold exactly.
//
//   Each type now has a written form and nothing else is guessed. Undeclared
//   limits still have a floor (DEFAULT_*). See tests/api/exception-inputs.test.ts
//   — every rule here has a row there that fails without it.
// ═══════════════════════════════════════════════════════════════════════════

import {
  type EntityTypeDef,
  type PropertyDef,
  type PropertyType,
  type OntologyError,
  PROVENANCE_FIELDS,
  DEFAULT_TEXT_MAX_LENGTH,
  DEFAULT_MAX_ITEMS,
  DEFAULT_JSON_MAX_LENGTH,
  ontologyError,
} from '../../types/index.js'

// ── Written forms ──────────────────────────────────────────────────────────

/** `YYYY-MM-DD` — a calendar day. No time: a timestamp in a date field is a day
 *  that shifts with the reader's clock (UTC 20:00 on the 12th is the 13th in +07). */
const DATE_FORM = /^(\d{4})-(\d{2})-(\d{2})$/
/** ISO 8601 / RFC 3339, plus the space separator Postgres writes. Seconds,
 *  fraction and zone are optional; a bare day is a datetime of reduced precision. */
const DATETIME_FORM =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-](\d{2})(?::?(\d{2}))?)?)?$/
const UUID_FORM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** C0 controls except TAB, LF, CR; DEL; C1 controls. What a pasted terminal
 *  log or a binary blob looks like — never what a person typed. U+0000 in
 *  particular cannot be stored in a Postgres `text` column at all. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/
/** Half a UTF-16 surrogate pair — not a character; the driver re-encodes it as U+FFFD. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

function isRealDay(y: number, m: number, d: number): boolean {
  if (y < 1 || m < 1 || m > 12 || d < 1) return false
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!
  return d <= days
}

export function isIsoDate(v: unknown): boolean {
  if (typeof v !== 'string') return false
  const m = DATE_FORM.exec(v)
  return !!m && isRealDay(+m[1]!, +m[2]!, +m[3]!)
}

export function isIsoDateTime(v: unknown): boolean {
  if (typeof v !== 'string') return false
  const m = DATETIME_FORM.exec(v)
  if (!m || !isRealDay(+m[1]!, +m[2]!, +m[3]!)) return false
  if (m[4] !== undefined && (+m[4] > 23 || +m[5]! > 59)) return false
  if (m[6] !== undefined && +m[6] > 59) return false
  if (m[8] !== undefined && +m[8] > 23) return false
  if (m[9] !== undefined && +m[9] > 59) return false
  return true
}

/** Characters, not UTF-16 units: an emoji flag is one character, two units. */
function charCount(s: string, stopAbove: number): number {
  if (s.length <= stopAbove) return s.length <= 1 ? s.length : [...s].length
  // More units than the limit — count only as far as needed to know.
  let n = 0
  for (const _ of s) {
    if (++n > stopAbove) return n
  }
  return n
}

const patternCache = new Map<string, RegExp>()
function compiled(pattern: string): RegExp {
  let re = patternCache.get(pattern)
  if (!re) {
    re = new RegExp(pattern, 'u')
    patternCache.set(pattern, re)
  }
  return re
}

// ── Which keywords mean something on which type ────────────────────────────

const TEXTLIKE: readonly PropertyType[] = ['text', 'file', 'catalogue']
const KEYWORD_TYPES: Record<string, readonly PropertyType[]> = {
  minLength: [...TEXTLIKE, 'text[]'],
  maxLength: [...TEXTLIKE, 'text[]', 'json'],
  pattern: [...TEXTLIKE, 'text[]'],
  minimum: ['number'],
  maximum: ['number'],
  exclusiveMinimum: ['number'],
  exclusiveMaximum: ['number'],
  multipleOf: ['number'],
  minItems: ['text[]'],
  maxItems: ['text[]'],
  formatMinimum: ['date', 'datetime'],
  formatMaximum: ['date', 'datetime'],
  accept: ['file'],
  maxBytes: ['file'],
}

/** `image/*` · `application/pdf` · `.pdf` — the three spellings `accept` takes. */
const ACCEPT_FORM = /^(\.[A-Za-z0-9]+|[a-z]+\/(\*|[A-Za-z0-9.+-]+))$/

/** Instant of a date or datetime literal, for ordering bounds. A bare day is its UTC midnight. */
const instant = (v: string) => Date.parse(DATE_FORM.test(v) ? `${v}T00:00:00Z` : v)
const COUNT_KEYWORDS = new Set(['minLength', 'maxLength', 'minItems', 'maxItems'])

/**
 * Is this property's constraint declaration meaningful? Returns the reason it
 * is not, or null. Run by SchemaRegistry at define time, so a broken
 * declaration fails at start-up instead of silently constraining nothing.
 */
export function constraintDeclarationError(p: PropertyDef): string | null {
  const rec = p as unknown as Record<string, unknown>
  for (const [kw, types] of Object.entries(KEYWORD_TYPES)) {
    const v = rec[kw]
    if (v === undefined) continue
    if (!types.includes(p.type)) return `"${kw}" does not apply to type "${p.type}" (applies to ${types.join(', ')})`
    if (kw === 'formatMinimum' || kw === 'formatMaximum') {
      const okForm = p.type === 'date' ? isIsoDate(v) : isIsoDateTime(v)
      if (!okForm) return `"${kw}" must be written as a ${p.type} (${p.type === 'date' ? 'YYYY-MM-DD' : 'ISO 8601'}), got ${JSON.stringify(v)}`
      continue
    }
    if (kw === 'pattern') {
      if (typeof v !== 'string' || v.length === 0) return `"pattern" must be a non-empty string`
      try {
        compiled(v)
      } catch (e) {
        return `"pattern" does not compile: ${(e as Error).message}`
      }
      // ⛔ THE BROWSER READS IT TOO, AND WITH A STRICTER FLAG. An `<input pattern>`
      //    compiles as `^(?:…)$` with flag `v`, where `/ - ( ) [ ] { } |` inside a
      //    character class must be escaped. A pattern valid under `u` and broken
      //    under `v` is IGNORED by the browser without a word: the box takes
      //    anything and the server refuses it after the typing is done. Measured
      //    12/9/2026 — 2 of 3 patterns in the reference app did exactly that.
      try {
        new RegExp(`^(?:${v})$`, 'v')
      } catch (e) {
        return `"pattern" does not compile in the browser (flag v), which ignores it silently: ${(e as Error).message}. `
          + 'Escape / - ( ) [ ] { } | inside a character class, e.g. [\\/\\-]'
      }
      continue
    }
    if (kw === 'accept') {
      if (!Array.isArray(v) || v.length === 0) return `"accept" must be a non-empty list of MIME types or extensions`
      const bad = v.find((x) => typeof x !== 'string' || !ACCEPT_FORM.test(x))
      if (bad !== undefined) return `"accept" entry ${JSON.stringify(bad)} is not a MIME type (image/png, image/*) or an extension (.pdf)`
      continue
    }
    if (kw === 'maxBytes') {
      if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) return `"maxBytes" must be a whole number of bytes above 0, got ${JSON.stringify(v)}`
      continue
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) return `"${kw}" must be a finite number, got ${JSON.stringify(v)}`
    if (COUNT_KEYWORDS.has(kw) && (!Number.isInteger(v) || v < 0)) return `"${kw}" must be a non-negative integer, got ${v}`
    if (kw === 'multipleOf' && v <= 0) return `"multipleOf" must be greater than 0, got ${v}`
  }
  const pairs: [string, string][] = [
    ['minLength', 'maxLength'],
    ['minItems', 'maxItems'],
    ['minimum', 'maximum'],
    ['exclusiveMinimum', 'exclusiveMaximum'],
    ['minimum', 'exclusiveMaximum'],
    ['exclusiveMinimum', 'maximum'],
  ]
  for (const [lo, hi] of pairs) {
    const a = rec[lo]
    const b = rec[hi]
    if (typeof a === 'number' && typeof b === 'number' && a > b) return `"${lo}" (${a}) is above "${hi}" (${b})`
  }
  if (typeof p.formatMinimum === 'string' && typeof p.formatMaximum === 'string'
    && instant(p.formatMinimum) > instant(p.formatMaximum)) {
    return `"formatMinimum" (${p.formatMinimum}) is after "formatMaximum" (${p.formatMaximum})`
  }
  return null
}

// ── Per-value checks ───────────────────────────────────────────────────────

type Violation = { code: 'TYPE_MISMATCH' | 'CONSTRAINT_VIOLATED' | 'ENUM_VALUE_INVALID' | 'REQUIRED_PROPERTY_MISSING'; message: string; keyword?: string; limit?: unknown }

const mismatch = (def: PropertyDef, value: unknown, why?: string): Violation => ({
  code: 'TYPE_MISMATCH',
  message: `Property "${def.name}" expected type "${def.type}" but got ${describe(value)}${why ? ` — ${why}` : ''}`,
  keyword: 'type',
})
const broke = (def: PropertyDef, keyword: string, limit: unknown, message: string): Violation => ({
  code: 'CONSTRAINT_VIOLATED',
  message: `Property "${def.name}" ${message}`,
  keyword,
  limit,
})

function describe(v: unknown): string {
  if (typeof v === 'string') return `"${v.length > 40 ? `${v.slice(0, 40)}…` : v}"`
  if (typeof v === 'number' || typeof v === 'boolean') return `${typeof v} ${String(v)}`
  if (Array.isArray(v)) return 'an array'
  if (v instanceof Date) return 'a Date object'
  return `"${typeof v}"`
}

/** Character + length + pattern checks shared by every string-valued type. */
function checkString(def: PropertyDef, s: string): Violation | null {
  const bad = FORBIDDEN_CHARS.exec(s)
  if (bad) {
    const code = bad[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')
    return broke(def, 'characters', null, `contains the control character U+${code} at position ${bad.index}`)
  }
  if (LONE_SURROGATE.test(s)) return broke(def, 'characters', null, 'contains half of a UTF-16 surrogate pair')
  const max = def.maxLength ?? DEFAULT_TEXT_MAX_LENGTH
  const n = charCount(s, max)
  if (n > max) return broke(def, 'maxLength', max, `is longer than ${max} characters`)
  // Blank is ABSENT, not a value: a required property already refuses it as
  // REQUIRED_PROPERTY_MISSING, and an optional one left empty has nothing to
  // match. The browser agrees — `pattern`/`minlength` never fire on an empty
  // box — so refusing `""` here is a form the screen accepted and the server
  // then bounced, on every optional field the caller sends as `""`.
  if (s.trim() === '') return null
  if (def.minLength !== undefined) {
    const t = s.trim()
    if (charCount(t, def.minLength) < def.minLength) {
      return broke(def, 'minLength', def.minLength, `is shorter than ${def.minLength} characters`)
    }
  }
  if (def.pattern !== undefined && !compiled(def.pattern).test(s)) {
    return broke(def, 'pattern', def.pattern, `does not match the pattern ${def.pattern}`)
  }
  return null
}

function checkNumber(def: PropertyDef, v: number): Violation | null {
  if (v > Number.MAX_SAFE_INTEGER) {
    return broke(def, 'maximum', Number.MAX_SAFE_INTEGER, 'is beyond the range a number can hold exactly')
  }
  if (v < Number.MIN_SAFE_INTEGER) {
    return broke(def, 'minimum', Number.MIN_SAFE_INTEGER, 'is beyond the range a number can hold exactly')
  }
  if (def.minimum !== undefined && v < def.minimum) return broke(def, 'minimum', def.minimum, `must be at least ${def.minimum}`)
  if (def.maximum !== undefined && v > def.maximum) return broke(def, 'maximum', def.maximum, `must be at most ${def.maximum}`)
  if (def.exclusiveMinimum !== undefined && v <= def.exclusiveMinimum) {
    return broke(def, 'exclusiveMinimum', def.exclusiveMinimum, `must be greater than ${def.exclusiveMinimum}`)
  }
  if (def.exclusiveMaximum !== undefined && v >= def.exclusiveMaximum) {
    return broke(def, 'exclusiveMaximum', def.exclusiveMaximum, `must be less than ${def.exclusiveMaximum}`)
  }
  if (def.multipleOf !== undefined) {
    // Float-tolerant: 19.99 / 0.01 is 1998.9999999999998, and 19.99 IS a whole number of cents.
    const q = v / def.multipleOf
    if (Math.abs(q - Math.round(q)) > 1e-9 * Math.max(1, Math.abs(q))) {
      return broke(def, 'multipleOf', def.multipleOf, `must be a multiple of ${def.multipleOf}`)
    }
  }
  return null
}

function checkWhen(def: PropertyDef, v: string): Violation | null {
  const t = instant(v)
  if (def.formatMinimum !== undefined && t < instant(def.formatMinimum)) {
    return broke(def, 'formatMinimum', def.formatMinimum, `must not be before ${def.formatMinimum}`)
  }
  if (def.formatMaximum !== undefined && t > instant(def.formatMaximum)) {
    return broke(def, 'formatMaximum', def.formatMaximum, `must not be after ${def.formatMaximum}`)
  }
  return null
}

/**
 * A `json` value must come back from the store as it went in. Anything
 * `JSON.stringify` would drop, rewrite or choke on is refused: NaN (→ null),
 * a Date (→ string), a function, a BigInt, a cycle.
 */
function jsonProblem(v: unknown, seen: Set<object>): string | null {
  if (v === null || typeof v === 'boolean') return null
  if (typeof v === 'string') return null
  if (typeof v === 'number') return Number.isFinite(v) ? null : `holds ${v}, which JSON writes as null`
  if (typeof v !== 'object') return `holds a ${typeof v}, which JSON cannot carry`
  if (seen.has(v)) return 'refers to itself'
  const proto = Object.getPrototypeOf(v)
  if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) {
    return `holds a ${(v as object).constructor?.name ?? 'non-plain'} object, which JSON does not round-trip`
  }
  seen.add(v)
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v)
  for (const [k, x] of entries) {
    // An undefined object member is simply absent after JSON — harmless. In an array it becomes null.
    if (x === undefined) {
      if (Array.isArray(v)) return `holds undefined at [${k}], which JSON writes as null`
      continue
    }
    const inner = jsonProblem(x, seen)
    if (inner) return inner
  }
  seen.delete(v)
  return null
}

function jsonStrings(v: unknown, out: string[]): void {
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) jsonStrings(x, out)
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.push(k)
      jsonStrings(x, out)
    }
  }
}

/** Every check for one present (non-null) value. */
function checkValue(def: PropertyDef, value: unknown): Violation | null {
  switch (def.type) {
    case 'text': {
      if (typeof value !== 'string') return mismatch(def, value)
      // Required means a value a person can read: "   " is present to the guard and empty to them.
      if (def.required && value.trim() === '') {
        return { code: 'REQUIRED_PROPERTY_MISSING', message: `Property "${def.name}" is required and cannot be blank` }
      }
      return checkString(def, value)
    }
    // A path inside the caller's file store / a key into a catalogue the caller
    // owns. Shape only — whether the bytes or the row exist is the store
    // owner's question. A blank is a missing value dressed up as a present one.
    case 'file':
    case 'catalogue':
      if (typeof value !== 'string' || value.trim().length === 0) return mismatch(def, value, 'blank')
      return checkString(def, value)
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) return mismatch(def, value)
      return checkNumber(def, value)
    case 'date':
      // @impl BR-007
      if (!isIsoDate(value)) return mismatch(def, value, 'write a real calendar day as YYYY-MM-DD')
      return checkWhen(def, value as string)
    case 'datetime':
      if (!isIsoDateTime(value)) return mismatch(def, value, 'write an ISO 8601 date-time')
      return checkWhen(def, value as string)
    case 'uuid':
      return typeof value === 'string' && UUID_FORM.test(value) ? null : mismatch(def, value)
    case 'enum':
      return typeof value === 'string' && (def.enumValues ?? []).includes(value)
        ? null
        : {
            code: 'ENUM_VALUE_INVALID',
            message: `Property "${def.name}" value "${String(value)}" is not in enum [${(def.enumValues ?? []).join(', ')}]`,
          }
    case 'text[]': {
      if (!Array.isArray(value)) return mismatch(def, value)
      if (!value.every((v) => typeof v === 'string')) return mismatch(def, value, 'every element must be text')
      const maxItems = def.maxItems ?? DEFAULT_MAX_ITEMS
      if (value.length > maxItems) return broke(def, 'maxItems', maxItems, `has more than ${maxItems} elements`)
      if (def.minItems !== undefined && value.length < def.minItems) {
        return broke(def, 'minItems', def.minItems, `has fewer than ${def.minItems} elements`)
      }
      for (const s of value as string[]) {
        const v = checkString(def, s)
        if (v) return v
      }
      return null
    }
    case 'json': {
      const problem = jsonProblem(value, new Set())
      if (problem) return mismatch(def, value, problem)
      const strings: string[] = []
      jsonStrings(value, strings)
      for (const s of strings) {
        if (FORBIDDEN_CHARS.test(s) || LONE_SURROGATE.test(s)) {
          return broke(def, 'characters', null, 'contains a control character or a broken surrogate pair')
        }
      }
      const max = def.maxLength ?? DEFAULT_JSON_MAX_LENGTH
      const size = JSON.stringify(value).length
      if (size > max) return broke(def, 'maxLength', max, `is larger than ${max} characters of JSON`)
      return null
    }
    default:
      return mismatch(def, value)
  }
}

/** What one value did wrong — the same code, keyword and limit the write guard reports. */
export type ValueViolation = {
  code: 'TYPE_MISMATCH' | 'CONSTRAINT_VIOLATED' | 'ENUM_VALUE_INVALID' | 'REQUIRED_PROPERTY_MISSING'
  message: string
  keyword?: string
  limit?: unknown
}

/**
 * Check ONE value against ONE property definition, exactly as the write guard
 * would — for a value that is not being written to an entity: a step parameter,
 * an import cell before it becomes a row. `null`/`undefined` is absent and
 * passes; whether it may be absent is the caller's `required` question.
 */
export function checkPropertyValue(def: PropertyDef, value: unknown): ValueViolation | null {
  if (value === null || value === undefined) return null
  return checkValue(def, value)
}

/**
 * Check an attached file against a `file` property's `accept` and `maxBytes`.
 *
 * The store keeps a path, so no write guard ever sees the bytes. This is the
 * one definition both sides use: the element before the upload, the endpoint
 * before it saves. A file with no MIME type (drag-and-drop from some systems)
 * is judged by its extension — never waved through for lacking one.
 */
export function fileViolation(def: PropertyDef, file: { name: string; type?: string; size: number }): ValueViolation | null {
  if (def.maxBytes !== undefined && file.size > def.maxBytes) {
    return broke(def, 'maxBytes', def.maxBytes, `is ${file.size} bytes, larger than ${def.maxBytes}`)
  }
  if (def.accept?.length) {
    const name = file.name.toLowerCase()
    const mime = (file.type ?? '').toLowerCase()
    const ok = def.accept.some((a) => {
      const k = a.toLowerCase()
      if (k.startsWith('.')) return name.endsWith(k)
      if (k.endsWith('/*')) return mime !== '' && mime.startsWith(k.slice(0, -1))
      return mime === k
    })
    if (!ok) return broke(def, 'accept', def.accept, `"${file.name}" is not one of ${def.accept.join(', ')}`)
  }
  return null
}

/**
 * Collect ALL validation errors for a property bag against the EntityType
 * (full instance on create, partial on update): unknown properties, type
 * mismatches, bad enum values, broken constraints, redeclared provenance
 * fields, and (on full validation) missing required properties. Returns an
 * empty array when valid.
 *
 * This is the single source of truth for "is this instance data well-formed".
 * The throwing {@link validateInstanceData} is the write-time guard (fail on
 * the first error); a pre-flight handoff validator can use this collect-all
 * form to surface every problem at once.
 *
 * Every error's `details` carries `entityType` and `property`; a broken
 * constraint also carries `keyword` and `limit`, so a form can put a sentence
 * in its own language under the right box without parsing this message.
 */
export function collectInstanceDataErrors(
  et: EntityTypeDef,
  data: Record<string, unknown>,
  opts: { partial: boolean },
): OntologyError[] {
  const errors: OntologyError[] = []
  const byName = new Map(et.properties.map((p) => [p.name, p]))

  for (const [key, value] of Object.entries(data)) {
    // Provenance fields are auto-injected — callers must not supply them in data.
    if (PROVENANCE_FIELDS.includes(key as never)) {
      errors.push(
        ontologyError(
          'PROVENANCE_FIELD_REDECLARED',
          `EntityType "${et.name}" data must not include provenance field "${key}" — the SDK injects it (NT3)`,
          { entityType: et.name, property: key },
        ),
      )
      continue
    }
    const def = byName.get(key)
    if (!def) {
      errors.push(
        ontologyError('UNKNOWN_PROPERTY', `EntityType "${et.name}" has no property "${key}"`, {
          entityType: et.name,
          property: key,
        }),
      )
      continue
    }
    // FR-N06: on partial (patch) update, setting a required property to null/undefined is rejected.
    if (value === null || value === undefined) {
      if (opts.partial && def.required) {
        errors.push(
          ontologyError(
            'REQUIRED_PROPERTY_MISSING',
            `EntityType "${et.name}" required property "${key}" cannot be set to null or undefined`,
            { entityType: et.name, property: key },
          ),
        )
      }
      continue // explicit clear allowed for non-required properties
    }
    const v = checkValue(def, value)
    if (v) {
      errors.push(
        ontologyError(v.code, v.message, {
          entityType: et.name,
          property: key,
          ...(v.code === 'TYPE_MISMATCH' ? { expected: def.type } : {}),
          ...(v.keyword !== undefined ? { keyword: v.keyword } : {}),
          ...(v.limit !== undefined ? { limit: v.limit } : {}),
        }),
      )
    }
  }

  if (!opts.partial) {
    for (const p of et.properties) {
      // Provenance fields (id, source_ref, confirmed_by, confirmed_at) are auto-injected
      // by the SDK from the `prov` parameter — they must not be expected in the `data` bag.
      if (PROVENANCE_FIELDS.includes(p.name as never)) continue
      if (p.required && (data[p.name] === undefined || data[p.name] === null)) {
        errors.push(
          ontologyError('REQUIRED_PROPERTY_MISSING', `EntityType "${et.name}" requires property "${p.name}"`, {
            entityType: et.name,
            property: p.name,
          }),
        )
      }
    }
  }

  return errors
}

/**
 * Validate a property bag against the EntityType, throwing on the first error.
 * The write-time guard (runs before any storage write, BR-007). Shares its
 * definition of "valid" with {@link collectInstanceDataErrors}.
 */
export function validateInstanceData(
  et: EntityTypeDef,
  data: Record<string, unknown>,
  opts: { partial: boolean },
): void {
  const errors = collectInstanceDataErrors(et, data, opts)
  if (errors.length > 0) throw errors[0]
}
