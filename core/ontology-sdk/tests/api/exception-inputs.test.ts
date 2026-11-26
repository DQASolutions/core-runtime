/**
 * EXCEPTION CASES — what the write path does with data a person should never
 * have been able to submit.
 *
 * WHY THIS FILE EXISTS
 *
 *   Every earlier test of the write guard was a happy case: the right type, the
 *   right shape, one wrong enum value. Measured 12/9/2026 by feeding 33 kinds of
 *   junk to `collectInstanceDataErrors`: 30 got through. A date field took `"1"`,
 *   `"hello 2"` and `"2026-02-31"` (JavaScript's `Date.parse` guesses a year for
 *   the first two and rolls the third into March). A text field took five
 *   million characters and a NUL byte — which Postgres cannot store, so it
 *   surfaced as a bare 500. A required name took `"   "`.
 *
 *   The guard is the ONE place every screen, every import and every script
 *   passes through. A browser `maxLength` protects one form; this protects the
 *   data.
 *
 * HOW TO READ IT
 *
 *   Each type has two lists. REJECT: values that must never be stored, with the
 *   error code the caller gets. ACCEPT: edge values that are legitimate and must
 *   keep working — a guard that is merely strict breaks real users instead of
 *   junk. Both lists run through `create` AND through `update`, because a patch
 *   is a second door and doors get forgotten.
 *
 * VOCABULARY
 *
 *   Constraints are JSON Schema's validation keywords, borrowed whole —
 *   `minLength · maxLength · pattern · minimum · maximum · exclusiveMinimum ·
 *   exclusiveMaximum · multipleOf · minItems · maxItems`. A violated one is
 *   `CONSTRAINT_VIOLATED` with `details.keyword` naming it, the way Ajv reports
 *   `keyword` + `params.limit`, so a UI can phrase "at most 50 characters"
 *   without parsing an English message.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  createOntology,
  InMemoryAdapter,
  OntologyError,
  DEFAULT_TEXT_MAX_LENGTH,
  DEFAULT_MAX_ITEMS,
  DEFAULT_JSON_MAX_LENGTH,
  type EntityTypeDef,
  type PropertyDef,
} from '../../src/index.js'

const ctx = { tenantId: 't-exception' }
const prov = { source_ref: 'exception-test', confirmed_by: 'tester', confirmed_at: '2026-09-12T00:00:00Z' }

const NUL = String.fromCharCode(0)
const BEL = String.fromCharCode(7)
const ESC = String.fromCharCode(27)
const DEL = String.fromCharCode(127)
const LONE_SURROGATE = '\uD800'
const long = (n: number) => 'x'.repeat(n)

const PROPS: PropertyDef[] = [
  { name: 'name', type: 'text', required: true },
  { name: 'note', type: 'text' },
  { name: 'nationalId', type: 'text', pattern: '^[0-9]{12}$' },
  { name: 'title', type: 'text', minLength: 3, maxLength: 50 },
  { name: 'body', type: 'text', maxLength: 20_000 },
  { name: 'qty', type: 'number', minimum: 0, multipleOf: 1 },
  { name: 'amount', type: 'number', exclusiveMinimum: 0 },
  { name: 'percent', type: 'number', minimum: 0, maximum: 100 },
  { name: 'cents', type: 'number', minimum: 0, multipleOf: 0.01 },
  { name: 'free', type: 'number' },
  { name: 'day', type: 'date' },
  { name: 'at', type: 'datetime' },
  { name: 'born', type: 'date', formatMinimum: '1900-01-01', formatMaximum: '2026-12-31' },
  { name: 'sentAt', type: 'datetime', formatMinimum: '2020-01-01T00:00:00Z' },
  { name: 'status', type: 'enum', enumValues: ['open', 'closed'] },
  { name: 'tags', type: 'text[]', maxItems: 5 },
  { name: 'aliases', type: 'text[]' },
  { name: 'scan', type: 'file' },
  { name: 'grade', type: 'catalogue', catalogue: 'Grade' },
  { name: 'meta', type: 'json' },
  { name: 'ref', type: 'uuid' },
]
const PROBE: EntityTypeDef = { name: 'Probe', label: 'Probe', properties: PROPS }
const BASE = { name: 'Nguyễn Văn A' }

let ontology: ReturnType<typeof createOntology>
beforeEach(async () => {
  ontology = createOntology({ adapter: new InMemoryAdapter() })
  await ontology.defineEntityType(PROBE, ctx)
})

async function caught(p: Promise<unknown>): Promise<OntologyError | null> {
  try {
    await p
    return null
  } catch (e) {
    return e as OntologyError
  }
}

type Reject = [value: unknown, code: string, keyword?: string]

/** One row: this value in this property must be refused — on create and on update. */
function rejects(prop: string, cases: Reject[]) {
  for (const [value, code, keyword] of cases) {
    it(`REJECT ${prop} = ${show(value)} → ${code}${keyword ? `/${keyword}` : ''}`, async () => {
      const onCreate = await caught(ontology.create('Probe', { ...BASE, [prop]: value }, prov, ctx))
      expect(onCreate, 'create accepted it').toBeInstanceOf(OntologyError)
      expect(onCreate!.code).toBe(code)
      if (keyword) expect((onCreate!.details as Record<string, unknown>)?.['keyword']).toBe(keyword)
      // The error must name the property, so a form can put the message under the right box.
      expect((onCreate!.details as Record<string, unknown>)?.['property']).toBe(prop)

      const inst = await ontology.create('Probe', BASE, prov, ctx)
      const onUpdate = await caught(ontology.update(inst.id, { [prop]: value }, prov, ctx))
      expect(onUpdate, 'update accepted it').toBeInstanceOf(OntologyError)
      expect(onUpdate!.code).toBe(code)
    })
  }
}

/** One row: this edge value is legitimate and must be stored unchanged. */
function accepts(prop: string, values: unknown[]) {
  for (const value of values) {
    it(`ACCEPT ${prop} = ${show(value)}`, async () => {
      const inst = await ontology.create('Probe', { ...BASE, [prop]: value }, prov, ctx)
      expect(inst.data[prop]).toEqual(value)
      const again = await ontology.update(inst.id, { [prop]: value }, prov, ctx)
      expect(again.data[prop]).toEqual(value)
    })
  }
}

function show(v: unknown): string {
  if (typeof v === 'string') {
    const s = v.length > 24 ? `${v.slice(0, 10)}…(${v.length} ký tự)` : v
    return JSON.stringify(s)
  }
  if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v)
  if (typeof v === 'bigint') return `${v}n`
  if (typeof v === 'function') return 'function'
  if (Array.isArray(v)) return v.length > 6 ? `[${v.length} phần tử]` : JSON.stringify(v)
  if (v instanceof Date) return `Date(${Number.isNaN(v.getTime()) ? 'Invalid' : v.toISOString()})`
  if (v && typeof v === 'object') return '{…}'
  return String(v)
}

// ─────────────────────────────────────────────────────────────────────────────
// TEXT
// ─────────────────────────────────────────────────────────────────────────────

describe('text — undeclared limits still have a floor', () => {
  rejects('note', [
    [123, 'TYPE_MISMATCH'],
    [true, 'TYPE_MISMATCH'],
    [{ a: 1 }, 'TYPE_MISMATCH'],
    [['a'], 'TYPE_MISMATCH'],
    // Postgres cannot store U+0000 in text — it used to surface as a bare 500.
    [`a${NUL}b`, 'CONSTRAINT_VIOLATED', 'characters'],
    // Control characters are what a pasted terminal log or binary blob looks like.
    [`ok${BEL}bell`, 'CONSTRAINT_VIOLATED', 'characters'],
    [`${ESC}[31mred`, 'CONSTRAINT_VIOLATED', 'characters'],
    [`x${DEL}`, 'CONSTRAINT_VIOLATED', 'characters'],
    // Half a UTF-16 pair: not a character at all, re-encoded as U+FFFD on the way to the DB.
    [`a${LONE_SURROGATE}`, 'CONSTRAINT_VIOLATED', 'characters'],
    [long(DEFAULT_TEXT_MAX_LENGTH + 1), 'CONSTRAINT_VIOLATED', 'maxLength'],
    [long(5_000_000), 'CONSTRAINT_VIOLATED', 'maxLength'],
  ])
  accepts('note', [
    '',
    'Nguyễn Thị Ánh Tuyết — tổ 3, ấp Đông',
    'dòng một\ndòng hai\r\n\tthụt lề',
    'emoji 🇻🇳 và chữ Hán 漢字',
    long(DEFAULT_TEXT_MAX_LENGTH),
    // Counted in characters, not UTF-16 units: 4000 flags is 8000 code units.
    '🇻'.repeat(DEFAULT_TEXT_MAX_LENGTH),
  ])
})

describe('text — required means a value a person can read', () => {
  rejects('name', [
    ['', 'REQUIRED_PROPERTY_MISSING'],
    ['   ', 'REQUIRED_PROPERTY_MISSING'],
    ['\n\t \r\n', 'REQUIRED_PROPERTY_MISSING'],
    ['  ', 'REQUIRED_PROPERTY_MISSING'], // no-break space, em space
    [null, 'REQUIRED_PROPERTY_MISSING'],
  ])
  it('REJECT create without the required property at all', async () => {
    const e = await caught(ontology.create('Probe', { note: 'x' }, prov, ctx))
    expect(e?.code).toBe('REQUIRED_PROPERTY_MISSING')
  })
})

describe('text — declared minLength / maxLength', () => {
  rejects('title', [
    ['ab', 'CONSTRAINT_VIOLATED', 'minLength'],
    // Padding with spaces must not buy the length the words do not have.
    ['  ab   ', 'CONSTRAINT_VIOLATED', 'minLength'],
    [long(51), 'CONSTRAINT_VIOLATED', 'maxLength'],
  ])
  accepts('title', ['abc', long(50), 'Ấn Độ']) // 'Ấn Độ' is 5 characters, not 7 bytes
  accepts('title', ['']) // optional and blank — absent, so no length to fall short of
})

describe('text — a declared maxLength above the default is honoured', () => {
  accepts('body', [long(DEFAULT_TEXT_MAX_LENGTH + 1), long(20_000)])
  rejects('body', [[long(20_001), 'CONSTRAINT_VIOLATED', 'maxLength']])
})

describe('text — declared pattern', () => {
  rejects('nationalId', [
    ['12345678901', 'CONSTRAINT_VIOLATED', 'pattern'],
    ['1234567890123', 'CONSTRAINT_VIOLATED', 'pattern'],
    ['12345678901a', 'CONSTRAINT_VIOLATED', 'pattern'],
    ['123456789012 ', 'CONSTRAINT_VIOLATED', 'pattern'],
    ['１２３４５６７８９０１２', 'CONSTRAINT_VIOLATED', 'pattern'], // full-width digits
  ])
  accepts('nationalId', ['001203004567'])
  // Blank on an OPTIONAL property is absent, not a value to match — the browser
  // lets an empty patterned box through, so the server must not bounce it.
  accepts('nationalId', ['', '   '])
})

// ─────────────────────────────────────────────────────────────────────────────
// NUMBER
// ─────────────────────────────────────────────────────────────────────────────

describe('number — undeclared range still has a floor', () => {
  rejects('free', [
    ['12', 'TYPE_MISMATCH'], // a form field that forgot to convert
    ['', 'TYPE_MISMATCH'],
    [true, 'TYPE_MISMATCH'],
    [[1], 'TYPE_MISMATCH'],
    [{}, 'TYPE_MISMATCH'],
    [NaN, 'TYPE_MISMATCH'],
    [Infinity, 'TYPE_MISMATCH'],
    [-Infinity, 'TYPE_MISMATCH'],
    [BigInt(5), 'TYPE_MISMATCH'],
    // Beyond 2^53 a JS number cannot hold every integer: 2^53 + 1 is stored as 2^53.
    [2 ** 53, 'CONSTRAINT_VIOLATED', 'maximum'],
    [1e300, 'CONSTRAINT_VIOLATED', 'maximum'],
    [-(2 ** 53), 'CONSTRAINT_VIOLATED', 'minimum'],
  ])
  accepts('free', [0, -5, 0.5, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER, 4_500_000_000])
})

describe('number — declared minimum + multipleOf 1 (a count)', () => {
  rejects('qty', [
    [-1, 'CONSTRAINT_VIOLATED', 'minimum'],
    [1.5, 'CONSTRAINT_VIOLATED', 'multipleOf'],
    [0.0001, 'CONSTRAINT_VIOLATED', 'multipleOf'],
  ])
  accepts('qty', [0, 1, 600, 1e9])
})

describe('number — declared exclusiveMinimum (money that must be paid)', () => {
  rejects('amount', [
    [0, 'CONSTRAINT_VIOLATED', 'exclusiveMinimum'],
    [-0.01, 'CONSTRAINT_VIOLATED', 'exclusiveMinimum'],
  ])
  accepts('amount', [0.01, 1_000_000_000])
})

describe('number — declared minimum + maximum (a percentage)', () => {
  rejects('percent', [
    [100.0001, 'CONSTRAINT_VIOLATED', 'maximum'],
    [-1, 'CONSTRAINT_VIOLATED', 'minimum'],
  ])
  accepts('percent', [0, 100, 33.3])
})

describe('number — multipleOf a fraction survives float arithmetic', () => {
  // 0.1 + 0.2 = 0.30000000000000004; 19.99 / 0.01 = 1998.9999999999998.
  // A naive `value % step === 0` rejects every one of these.
  accepts('cents', [19.99, 0.3, 1234.56, 0.07])
  rejects('cents', [[0.001, 'CONSTRAINT_VIOLATED', 'multipleOf']])
})

// ─────────────────────────────────────────────────────────────────────────────
// DATE / DATETIME
// ─────────────────────────────────────────────────────────────────────────────

describe('date — a calendar day written YYYY-MM-DD, nothing guessed', () => {
  rejects('day', [
    ['1', 'TYPE_MISMATCH'], // Date.parse → 2001-01-01
    ['0', 'TYPE_MISMATCH'], // Date.parse → 2000-01-01
    ['hello 2', 'TYPE_MISMATCH'], // Date.parse → 2001-02-01
    ['2026-02-31', 'TYPE_MISMATCH'], // Date.parse → 2026-03-03
    ['2025-02-29', 'TYPE_MISMATCH'], // not a leap year
    ['2026-13-01', 'TYPE_MISMATCH'],
    ['2026-00-10', 'TYPE_MISMATCH'],
    ['2026-09-00', 'TYPE_MISMATCH'],
    ['2026', 'TYPE_MISMATCH'],
    ['2026-9-1', 'TYPE_MISMATCH'],
    ['12/09/2026', 'TYPE_MISMATCH'], // is it 12 Sept or 9 Dec? refuse to guess
    [' 2026-09-12', 'TYPE_MISMATCH'],
    ['99999-01-01', 'TYPE_MISMATCH'],
    ['0000-01-01', 'TYPE_MISMATCH'], // there is no year zero
    // A timestamp in a date field is the seven-hour bug: 2026-09-12T20:00Z is the 13th in Hà Nội.
    ['2026-09-12T20:00:00Z', 'TYPE_MISMATCH'],
    ['', 'TYPE_MISMATCH'],
    [20260912, 'TYPE_MISMATCH'],
    [new Date('2026-09-12'), 'TYPE_MISMATCH'],
  ])
  accepts('day', ['2026-09-12', '2024-02-29', '2000-02-29', '0001-01-01', '9999-12-31'])
})

describe('datetime — ISO 8601, every component in range', () => {
  rejects('at', [
    ['1', 'TYPE_MISMATCH'],
    ['now', 'TYPE_MISMATCH'],
    ['Sep 12 2026', 'TYPE_MISMATCH'],
    ['2026-02-30T10:00', 'TYPE_MISMATCH'],
    ['2026-09-12T24:01', 'TYPE_MISMATCH'],
    ['2026-09-12T10:60', 'TYPE_MISMATCH'],
    ['2026-09-12T10:00:61', 'TYPE_MISMATCH'],
    ['2026-09-12T10:00:00+25:00', 'TYPE_MISMATCH'],
    ['2026-09-12T10', 'TYPE_MISMATCH'],
    ['', 'TYPE_MISMATCH'],
    [1757660400000, 'TYPE_MISMATCH'], // epoch millis: a number, not a datetime
  ])
  accepts('at', [
    '2026-09-12T10:00', // what <input type="datetime-local"> sends
    '2026-09-12T10:00:00Z',
    '2026-09-12T10:00:00.123+07:00',
    '2026-09-12 10:00:00', // what Postgres hands back
    '2026-09-12', // a day is a datetime of reduced precision
    '2026-09-12T00:00:00.000Z',
  ])
})

describe('date / datetime — declared bounds (a date box without them takes year 20266)', () => {
  rejects('born', [
    ['1899-12-31', 'CONSTRAINT_VIOLATED', 'formatMinimum'],
    ['0275-01-01', 'CONSTRAINT_VIOLATED', 'formatMinimum'],
    ['2027-01-01', 'CONSTRAINT_VIOLATED', 'formatMaximum'],
  ])
  accepts('born', ['1900-01-01', '1985-06-15', '2026-12-31'])
  rejects('sentAt', [['2019-12-31T23:59:59Z', 'CONSTRAINT_VIOLATED', 'formatMinimum']])
  // Same instant, other zone: 2020-01-01T06:59+07:00 is 2019-12-31T23:59Z — before the bound.
  rejects('sentAt', [['2020-01-01T06:59:00+07:00', 'CONSTRAINT_VIOLATED', 'formatMinimum']])
  accepts('sentAt', ['2020-01-01T07:00:00+07:00', '2026-09-12T10:00:00Z'])
})

// ─────────────────────────────────────────────────────────────────────────────
// ENUM · FILE · CATALOGUE · UUID
// ─────────────────────────────────────────────────────────────────────────────

describe('enum — exact value, no case folding, no trimming', () => {
  rejects('status', [
    ['OPEN', 'ENUM_VALUE_INVALID'],
    [' open', 'ENUM_VALUE_INVALID'],
    ['', 'ENUM_VALUE_INVALID'],
    [1, 'ENUM_VALUE_INVALID'],
    [['open'], 'ENUM_VALUE_INVALID'],
  ])
  accepts('status', ['open', 'closed'])
})

describe('file — a path, not a paste', () => {
  rejects('scan', [
    ['   ', 'TYPE_MISMATCH'],
    [42, 'TYPE_MISMATCH'],
    [`scans/a${NUL}.png`, 'CONSTRAINT_VIOLATED', 'characters'],
    [long(DEFAULT_TEXT_MAX_LENGTH + 1), 'CONSTRAINT_VIOLATED', 'maxLength'],
  ])
  accepts('scan', ['scans/2026/12-qd.png', 'hồ sơ/quyết định số 12.pdf'])
})

describe('catalogue — a key, not a paste', () => {
  rejects('grade', [
    ['', 'TYPE_MISMATCH'],
    [7, 'TYPE_MISMATCH'],
    [`senior${BEL}`, 'CONSTRAINT_VIOLATED', 'characters'],
    [long(DEFAULT_TEXT_MAX_LENGTH + 1), 'CONSTRAINT_VIOLATED', 'maxLength'],
  ])
  accepts('grade', ['senior', 'bac-3'])
})

describe('uuid — the column is `uuid`; anything else is a 500 waiting to happen', () => {
  rejects('ref', [
    ['not-a-uuid', 'TYPE_MISMATCH'],
    ['', 'TYPE_MISMATCH'],
    ['3f2b8c1e-5d4a-4c3b-9a8f', 'TYPE_MISMATCH'],
    [123, 'TYPE_MISMATCH'],
  ])
  accepts('ref', ['3f2b8c1e-5d4a-4c3b-9a8f-0e1d2c3b4a59', '3F2B8C1E-5D4A-4C3B-9A8F-0E1D2C3B4A59'])
})

// ─────────────────────────────────────────────────────────────────────────────
// TEXT[] · JSON
// ─────────────────────────────────────────────────────────────────────────────

describe('text[] — every element is text, and the list has an end', () => {
  rejects('tags', [
    ['a', 'TYPE_MISMATCH'],
    [[1], 'TYPE_MISMATCH'],
    [['a', null], 'TYPE_MISMATCH'],
    [['a', `b${NUL}`], 'CONSTRAINT_VIOLATED', 'characters'],
    [['a', 'b', 'c', 'd', 'e', 'f'], 'CONSTRAINT_VIOLATED', 'maxItems'],
    [[long(DEFAULT_TEXT_MAX_LENGTH + 1)], 'CONSTRAINT_VIOLATED', 'maxLength'],
  ])
  accepts('tags', [[], ['a'], ['a', 'b', 'c', 'd', 'e']])
  rejects('aliases', [[Array(DEFAULT_MAX_ITEMS + 1).fill('a'), 'CONSTRAINT_VIOLATED', 'maxItems']])
  accepts('aliases', [Array(DEFAULT_MAX_ITEMS).fill('a')])
})

describe('json — must survive JSON, and has a size', () => {
  const circular: Record<string, unknown> = {}
  circular['self'] = circular
  rejects('meta', [
    [() => 1, 'TYPE_MISMATCH'],
    [BigInt(1), 'TYPE_MISMATCH'],
    [circular, 'TYPE_MISMATCH'],
    [{ n: NaN }, 'TYPE_MISMATCH'], // JSON.stringify writes null — the value silently changes
    [{ d: new Date('2026-09-12') }, 'TYPE_MISMATCH'], // comes back as a string
    [{ big: long(DEFAULT_JSON_MAX_LENGTH) }, 'CONSTRAINT_VIOLATED', 'maxLength'],
    [{ s: `a${NUL}` }, 'CONSTRAINT_VIOLATED', 'characters'],
  ])
  accepts('meta', [{ a: 1, b: ['x', { c: true }] }, [], 0, false, 'chuỗi'])
})

// ─────────────────────────────────────────────────────────────────────────────
// CLEARING — a null is not a value, and only optional properties may be cleared
// ─────────────────────────────────────────────────────────────────────────────

describe('clearing', () => {
  it('ACCEPT clearing optional properties of every type with null', async () => {
    const inst = await ontology.create('Probe', { ...BASE, note: 'x', qty: 1, day: '2026-09-12' }, prov, ctx)
    const cleared = await ontology.update(inst.id, { note: null, qty: null, day: null, meta: null }, prov, ctx)
    expect(cleared.data['note'] ?? null).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DECLARATIONS — a constraint that cannot mean anything is refused at start-up
// ─────────────────────────────────────────────────────────────────────────────

describe('constraint declarations are checked when the type is defined', () => {
  const bad: [label: string, p: PropertyDef][] = [
    ['maxLength on a number', { name: 'x', type: 'number', maxLength: 5 }],
    ['minimum on text', { name: 'x', type: 'text', minimum: 0 }],
    ['maxItems on text', { name: 'x', type: 'text', maxItems: 3 }],
    ['pattern on a number', { name: 'x', type: 'number', pattern: '^1$' }],
    ['negative maxLength', { name: 'x', type: 'text', maxLength: -1 }],
    ['fractional maxLength', { name: 'x', type: 'text', maxLength: 1.5 }],
    ['maxLength written as a string', { name: 'x', type: 'text', maxLength: '10' as unknown as number }],
    ['minLength above maxLength', { name: 'x', type: 'text', minLength: 10, maxLength: 5 }],
    ['minimum above maximum', { name: 'x', type: 'number', minimum: 10, maximum: 5 }],
    ['NaN minimum', { name: 'x', type: 'number', minimum: NaN }],
    ['zero multipleOf', { name: 'x', type: 'number', multipleOf: 0 }],
    ['negative multipleOf', { name: 'x', type: 'number', multipleOf: -1 }],
    ['pattern that does not compile', { name: 'x', type: 'text', pattern: '([' }],
    ['empty pattern', { name: 'x', type: 'text', pattern: '' }],
    ['formatMinimum on a number', { name: 'x', type: 'number', formatMinimum: '2026-01-01' }],
    ['formatMinimum not a date', { name: 'x', type: 'date', formatMinimum: '01/01/2026' }],
    ['formatMaximum not a real day', { name: 'x', type: 'date', formatMaximum: '2026-02-30' }],
    ['formatMinimum after formatMaximum', { name: 'x', type: 'date', formatMinimum: '2026-12-31', formatMaximum: '2026-01-01' }],
    ['minimum on a date (the bound of a date is formatMinimum)', { name: 'x', type: 'date', minimum: 0 }],
  ]
  for (const [label, p] of bad) {
    it(`REJECT declaring ${label}`, async () => {
      const fresh = createOntology({ adapter: new InMemoryAdapter() })
      const e = await caught(fresh.defineEntityType({ name: 'Bad', label: 'Bad', properties: [p] }, ctx))
      expect(e, 'the declaration was accepted').toBeInstanceOf(OntologyError)
      expect(e!.code).toBe('INVALID_CONSTRAINT')
    })
  }
})
