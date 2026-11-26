/**
 * FORMAT — what a person TYPES is not what the store keeps.
 *
 *   The guard (`validateInstanceData`) accepts exactly one written form per
 *   type: `2026-09-12`, `1234567.5`. People do not type that. A Vietnamese
 *   officer types `12/9/2026`, `1.234.567,5`, `10h30`, or pastes
 *   `ngày 12 tháng 9 năm 2026` out of a decree. Before this module every form
 *   and every CSV import turned that into a wire value on its own — `Number()`
 *   here, a `split('/')` there — and they disagreed:
 *
 *     · `Number('1.000.000')` is NaN, so a money field typed the way the screen
 *       itself DISPLAYS money was refused, or silently dropped;
 *     · `Number('1e3')` is 1000 and `Number('0x10')` is 16 — accepted;
 *     · `Number('')` is 0 — a blank box became a zero.
 *
 * THE RULES THIS FILE PINS
 *
 *   ① One reading or none. A spelling with two plausible readings is REFUSED
 *     (`ambiguous`), never resolved by a guess: `1,000` (one, or one thousand?),
 *     `12092026` (which digits are the day?), `12/09/26` (which century?).
 *   ② Vietnamese order. `12/09/2026` is the 12th of September. A day that does
 *     not exist in that order (`09/13/2026`) is refused — never swapped.
 *   ③ What the screen displays, the box reads back. Anything
 *     `Intl.NumberFormat('vi-VN')` prints parses to the same number.
 *   ④ Blank is ABSENT, not zero and not "". `''` → null.
 *   ⑤ Every value this module returns passes the guard; every constraint the
 *     property declares is applied here too, with the same keyword.
 */

import { describe, it, expect } from 'vitest'
import { parseTypedInput, collectInstanceDataErrors, type PropertyDef } from '../../src/index.js'

const P = {
  text: { name: 'note', type: 'text' },
  name: { name: 'fullName', type: 'text', required: true, maxLength: 10 },
  num: { name: 'free', type: 'number' },
  vnd: { name: 'amount', type: 'number', minimum: 0, multipleOf: 1, maximum: 100_000_000_000 },
  day: { name: 'day', type: 'date' },
  at: { name: 'at', type: 'datetime' },
  status: { name: 'status', type: 'enum', enumValues: ['open', 'closed'] },
} satisfies Record<string, PropertyDef>

function ok(def: PropertyDef, raw: string, expected: unknown, opts?: Parameters<typeof parseTypedInput>[2]) {
  it(`${def.type}${def.multipleOf ? '(VND)' : ''} ${JSON.stringify(raw)} → ${JSON.stringify(expected)}`, () => {
    const r = parseTypedInput(def, raw, opts)
    expect(r).toEqual({ ok: true, value: expected })
    // ⑤ — what comes out is something the store accepts.
    if (expected !== null) {
      const et = { name: 'X', label: 'X', properties: [def] }
      expect(collectInstanceDataErrors(et, { [def.name]: expected }, { partial: true })).toEqual([])
    }
  })
}

function no(def: PropertyDef, raw: string, reason: string, opts?: Parameters<typeof parseTypedInput>[2]) {
  it(`${def.type}${def.multipleOf ? '(VND)' : ''} ${JSON.stringify(raw)} ✗ ${reason}`, () => {
    const r = parseTypedInput(def, raw, opts)
    expect(r.ok, `accepted as ${JSON.stringify((r as { value?: unknown }).value)}`).toBe(false)
    if (!r.ok) expect(r.reason).toBe(reason)
  })
}

// ─────────────────────────────────────────────────────────────────────────────

describe('blank is absent (④)', () => {
  ok(P.text, '', null)
  ok(P.text, '   ', null)
  ok(P.num, '', null) // Number('') is 0 — a blank box must not become a zero
  ok(P.num, '  ', null)
  ok(P.day, '', null)
  no(P.name, '', 'required')
  no(P.name, ' \t ', 'required')
})

describe('number — plain', () => {
  ok(P.num, '0', 0)
  ok(P.num, '42', 42)
  ok(P.num, ' 42 ', 42)
  ok(P.num, '-5', -5)
  ok(P.num, '−5', -5) // U+2212, what Intl prints for a minus in some locales
  ok(P.num, '+5', 5)
  ok(P.num, '１２３', 123) // full-width digits from a Vietnamese IME
})

describe('number — Vietnamese convention: dot groups, comma decimal (③)', () => {
  ok(P.num, '1.000.000', 1_000_000)
  ok(P.num, '1.234.567,89', 1_234_567.89)
  ok(P.num, '1,5', 1.5)
  ok(P.num, '0,25', 0.25)
  ok(P.num, ',5', 0.5)
  ok(P.num, '2.500', 2500) // a single dot group of three IS a thousands group in vi
  ok(P.num, '1 000 000', 1_000_000)
  ok(P.num, '1 000 000', 1_000_000) // no-break space, as Intl prints it
  ok(P.num, '1 000', 1000) // narrow no-break space
  ok(P.num, '-1.234,5', -1234.5)
})

describe('number — keyboard habits that have ONE reading', () => {
  ok(P.num, '1.5', 1.5) // a dot followed by one digit cannot be a thousands group
  ok(P.num, '33.33', 33.33)
  ok(P.num, '1234.5', 1234.5)
  ok(P.num, '1,234,567', 1_234_567) // two commas cannot both be decimal points
  ok(P.num, '1,234.5', 1234.5) // English full form: comma groups before a dot decimal
})

describe('number — refused (①)', () => {
  no(P.num, '1,000', 'ambiguous') // vi: 1.000 (one); en: 1000 (one thousand)
  no(P.num, '12,500', 'ambiguous')
  no(P.num, '1e3', 'format') // Number() says 1000
  no(P.num, '0x10', 'format') // Number() says 16
  no(P.num, 'Infinity', 'format')
  no(P.num, 'NaN', 'format')
  no(P.num, '12abc', 'format')
  no(P.num, 'abc', 'format')
  no(P.num, '--1', 'format')
  no(P.num, '1-', 'format')
  no(P.num, '1.2.3', 'format')
  no(P.num, '1.23.456', 'format') // groups must be three digits
  no(P.num, '1,2,3', 'format')
  no(P.num, '1.234,5,6', 'format')
  no(P.num, '1,234.567,8', 'format')
  no(P.num, '.', 'format')
  no(P.num, '-', 'format')
  no(P.num, '(5)', 'format')
  no(P.num, '1 2 3', 'format')
  no(P.num, '5%', 'format')
  no(P.num, '1.000 đ', 'format')
})

describe('number — precision a float64 cannot keep (BUG-005)', () => {
  no(P.num, '9007199254740993', 'precision') // 2^53 + 1 would be stored as 2^53
  no(P.num, '12345678901234567', 'precision')
  no(P.num, '0,12345678901234567', 'precision') // 17 significant digits
  ok(P.num, '9.007.199.254.740.991', Number.MAX_SAFE_INTEGER)
  ok(P.num, '0,1', 0.1)
})

describe('number — declared constraints are applied here, same keyword (⑤)', () => {
  ok(P.vnd, '1.500.000', 1_500_000)
  ok(P.vnd, '0', 0)
  no(P.vnd, '1.500.000,5', 'multipleOf') // BUG-024: VND has no fractions
  no(P.vnd, '-1.000', 'minimum') // BUG-062: refused, never pushed up to 0
  no(P.vnd, '100.000.000.001', 'maximum') // BUG-006: a sub-item amount has a ceiling
})

// ─────────────────────────────────────────────────────────────────────────────

describe('date — accepted spellings (②)', () => {
  ok(P.day, '2026-09-12', '2026-09-12')
  ok(P.day, '12/09/2026', '2026-09-12')
  ok(P.day, '12/9/2026', '2026-09-12')
  ok(P.day, '1/9/2026', '2026-09-01')
  ok(P.day, '12-09-2026', '2026-09-12')
  ok(P.day, '12.09.2026', '2026-09-12')
  ok(P.day, ' 12/09/2026 ', '2026-09-12')
  ok(P.day, '2026/09/12', '2026-09-12') // four digits first: year-month-day, one reading
  ok(P.day, 'ngày 12 tháng 9 năm 2026', '2026-09-12') // as a decree writes it
  ok(P.day, 'Ngày 01 tháng 01 năm 2026', '2026-01-01')
  ok(P.day, '29/02/2024', '2024-02-29')
})

describe('date — refused', () => {
  no(P.day, '31/02/2026', 'no-such-day') // Date would roll it to 3 March
  no(P.day, '29/02/2025', 'no-such-day')
  no(P.day, '09/13/2026', 'no-such-day') // US order: month 13 — refused, never swapped
  no(P.day, '00/09/2026', 'no-such-day')
  no(P.day, '12/09/26', 'ambiguous') // 1926 or 2026?
  no(P.day, '12092026', 'ambiguous') // 12 Sep or… 2026-09-12 written backwards?
  no(P.day, '20260912', 'ambiguous')
  no(P.day, '2026-09-12T10:00:00Z', 'format') // a moment is not a day
  no(P.day, 'Sep 12, 2026', 'format')
  no(P.day, '12 Sep 2026', 'format')
  no(P.day, 'hôm nay', 'format')
  no(P.day, '1', 'format')
  no(P.day, '12/09', 'format') // no year
  no(P.day, '12//2026', 'format')
  no(P.day, '12/09/02026', 'format')
})

// ─────────────────────────────────────────────────────────────────────────────

describe('datetime — accepted spellings; the zone is the caller\'s to give', () => {
  ok(P.at, '2026-09-12T10:30', '2026-09-12T10:30')
  ok(P.at, '2026-09-12T10:30:00Z', '2026-09-12T10:30:00Z')
  ok(P.at, '12/09/2026 10:30', '2026-09-12T10:30')
  ok(P.at, '12/09/2026 10:30:15', '2026-09-12T10:30:15')
  ok(P.at, '12/09/2026 10h30', '2026-09-12T10:30')
  ok(P.at, '12/09/2026 10h', '2026-09-12T10:00')
  ok(P.at, '12/09/2026 9:05', '2026-09-12T09:05')
  ok(P.at, '10:30 12/09/2026', '2026-09-12T10:30') // time first, as minutes are often written
  ok(P.at, '12/09/2026 10:30 SA', '2026-09-12T10:30')
  ok(P.at, '12/09/2026 10:30 CH', '2026-09-12T22:30')
  ok(P.at, '12/09/2026 12:15 SA', '2026-09-12T00:15')
  ok(P.at, '12/09/2026 12:15 CH', '2026-09-12T12:15')
  ok(P.at, '12/09/2026 10:30 PM', '2026-09-12T22:30')
  // A zone-less wall time is only an instant once somebody says WHERE.
  ok(P.at, '12/09/2026 10:30', '2026-09-12T10:30+07:00', { offset: '+07:00' })
  ok(P.at, '2026-09-12T10:30Z', '2026-09-12T10:30Z', { offset: '+07:00' }) // a written zone wins
})

describe('datetime — refused', () => {
  no(P.at, '12/09/2026 24:00', 'no-such-time')
  no(P.at, '12/09/2026 10:60', 'no-such-time')
  no(P.at, '12/09/2026 13:00 CH', 'no-such-time') // 13 o'clock in the afternoon
  no(P.at, '12/09/2026 0:30 SA', 'no-such-time')
  no(P.at, '31/09/2026 10:00', 'no-such-day')
  no(P.at, '12/09/26 10:00', 'ambiguous')
  no(P.at, '12/09/2026 10', 'format') // ten what?
  no(P.at, '12/09/2026 10.30', 'format') // dot is a date separator here — refuse to guess
  no(P.at, 'now', 'format')
  no(P.at, '1757660400000', 'format') // epoch millis
})

// ─────────────────────────────────────────────────────────────────────────────

describe('text — trimmed, composed, then held to the guard', () => {
  ok(P.text, '  Nguyễn Văn A  ', 'Nguyễn Văn A')
  // macOS and some copy-paste hand over DECOMPOSED Vietnamese: "e" + U+0302 + U+0301.
  // It looks identical and compares unequal — a search for "Nguyễn" misses it.
  ok(P.text, 'Nguyễn', 'Nguyễn')
  ok(P.name, 'An', 'An')
  no(P.name, 'Nguyễn Văn Anh', 'maxLength') // 14 > 10
  no(P.text, `a${String.fromCharCode(0)}b`, 'characters')
})

describe('enum — exact value after trimming', () => {
  ok(P.status, ' open ', 'open')
  no(P.status, 'OPEN', 'enum')
  no(P.status, 'mở', 'enum')
})

// ─────────────────────────────────────────────────────────────────────────────
// ③ — the display format round-trips
// ─────────────────────────────────────────────────────────────────────────────

describe('what vi-VN displays, the box reads back (③)', () => {
  const vi = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 6 })
  for (const n of [0, 7, 999, 1000, 2500, 1_000_000, 4_500_000_000, 1234.5, 0.25, -1234.56, 33.3333]) {
    it(`${n} → "${vi.format(n)}" → ${n}`, () => {
      expect(parseTypedInput(P.num, vi.format(n))).toEqual({ ok: true, value: n })
    })
  }
  const dd = new Intl.DateTimeFormat('vi-VN', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' })
  for (const iso of ['2026-09-12', '2024-02-29', '2000-01-01']) {
    it(`${iso} → "${dd.format(new Date(`${iso}T00:00:00Z`))}" → ${iso}`, () => {
      expect(parseTypedInput(P.day, dd.format(new Date(`${iso}T00:00:00Z`)))).toEqual({ ok: true, value: iso })
    })
  }
})
