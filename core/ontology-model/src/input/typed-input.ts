// FROM WHAT A PERSON TYPED TO WHAT THE STORE KEEPS.
//
// ═══════════════════════════════════════════════════════════════════════════
// The write guard (core/graph/validation.ts) accepts ONE written form per type:
// `2026-09-12`, `1234567.5`. People type `12/9/2026`, `1.234.567,5`, `10h30`.
// Before this module every form and every import made that conversion on its
// own — `Number()` in one place, `split('/')` in another — and they disagreed:
// `Number('1.000.000')` is NaN (the way the screen DISPLAYS money was refused),
// `Number('1e3')` is 1000, `Number('0x10')` is 16, `Number('')` is 0.
//
// ⭐ THE RULE: one reading or none. A spelling with two plausible readings is
//    refused as `ambiguous` — `1,000`, `12092026`, `12/09/26` — never settled
//    by a guess. A guess that is wrong one time in a hundred is a wrong amount
//    of money one time in a hundred, and nothing downstream can tell.
//
// ⭐ Vietnamese order and convention: day/month/year; dot groups thousands,
//    comma marks decimals — the inverse of `Intl.NumberFormat('vi-VN')`, so
//    whatever the screen prints, the box reads back.
//
// ⭐ The result always passes the guard: after parsing, the property's own
//    constraints run through `collectInstanceDataErrors`, and a violation comes
//    back with the SAME keyword the server would use.
//
// Pure: no I/O, no `pg`. Reachable as `@dqa-ai-solutions/ontology-sdk/input` so a browser
// bundle can import it without the storage adapters.
// See tests/input/typed-input.test.ts.
// ═══════════════════════════════════════════════════════════════════════════

import type { PropertyDef } from '../types/index.js'
import { collectInstanceDataErrors, isIsoDate, isIsoDateTime } from '../core/graph/validation.js'

export type ParseFailureReason =
  /** Blank, and the property is required. */
  | 'required'
  /** Not a spelling of this type at all. */
  | 'format'
  /** A spelling with more than one plausible reading. */
  | 'ambiguous'
  /** More significant digits than a float64 keeps exactly. */
  | 'precision'
  /** Well-formed, but the calendar has no such day (31/02, month 13). */
  | 'no-such-day'
  /** Well-formed, but the clock has no such time (24:00, 10:60, 13h CH). */
  | 'no-such-time'
  /** Not one of the enum's values. */
  | 'enum'
  /** The guard's own verdict — `type`, `characters`, or a constraint keyword. */
  | string

export type ParseResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: ParseFailureReason; limit?: unknown; message: string }

export interface ParseOptions {
  /**
   * The zone a wall time was typed in, e.g. `+07:00`. Appended to a datetime
   * typed without one. Omitted → the value stays zone-less, and whoever stores
   * it decides — which is how a 10:30 in Hà Nội becomes 10:30 UTC.
   */
  offset?: string
}

const fail = (reason: ParseFailureReason, message: string, limit?: unknown): ParseResult =>
  limit === undefined ? { ok: false, reason, message } : { ok: false, reason, message, limit }

/**
 * Read one typed value for one property. Blank → `{ ok: true, value: null }`
 * (absent — not zero, not ""), unless the property is required.
 */
export function parseTypedInput(def: PropertyDef, raw: string, opts: ParseOptions = {}): ParseResult {
  if (typeof raw !== 'string') return fail('format', 'expected typed text')
  const loose = def.type === 'text' ? raw.normalize('NFC') : raw.normalize('NFKC')
  const s = loose.trim()
  if (s === '') return def.required ? fail('required', `"${def.name}" is required`) : { ok: true, value: null }

  let r: ParseResult
  switch (def.type) {
    case 'number':
      r = parseNumber(s)
      break
    case 'date':
      r = parseDate(s)
      break
    case 'datetime':
      r = parseDateTime(s, opts)
      break
    case 'text[]':
      r = { ok: true, value: s.split(/\r?\n/).map((x) => x.trim()).filter((x) => x !== '') }
      break
    case 'json':
      try {
        r = { ok: true, value: JSON.parse(s) as unknown }
      } catch {
        r = fail('format', 'not valid JSON')
      }
      break
    default:
      // text · enum · file · catalogue · uuid — the trimmed string is the value.
      r = { ok: true, value: s }
  }
  return r.ok ? guard(def, r.value) : r
}

/** The property's own constraints, with the server's keyword. One decision, two callers. */
function guard(def: PropertyDef, value: unknown): ParseResult {
  const et = { name: 'Input', label: 'Input', properties: [def] }
  const [e] = collectInstanceDataErrors(et, { [def.name]: value }, { partial: true })
  if (!e) return { ok: true, value }
  const d = (e.details ?? {}) as { keyword?: string; limit?: unknown }
  const reason =
    e.code === 'ENUM_VALUE_INVALID' ? 'enum'
    : e.code === 'REQUIRED_PROPERTY_MISSING' ? 'required'
    : (d.keyword ?? 'type')
  return fail(reason, e.message, d.limit)
}

// ── Numbers ────────────────────────────────────────────────────────────────

const GROUPED = (sep: string) => new RegExp(`^[1-9]\\d{0,2}(?:\\${sep}\\d{3})+$`)
const GROUPED_DOT = GROUPED('.')
const GROUPED_COMMA = GROUPED(',')
const GROUPED_SPACE = /^[1-9]\d{0,2}(?: \d{3})+$/

function parseNumber(input: string): ParseResult {
  // NFKC already turned full-width digits and no-break spaces into ASCII.
  const s = input.replace(/−/g, '-').replace(/\s+/g, ' ')
  const m = /^([+-]?)([\d., ]+)$/.exec(s)
  if (!m || !/\d/.test(m[2]!)) return fail('format', `"${input}" is not a number`)
  const sign = m[1] === '-' ? '-' : ''
  let body = m[2]!

  let intPart: string
  let fracPart = ''

  // Space-grouped: "1 000 000" or "1 234,5" / "1 234.5".
  if (body.includes(' ')) {
    const sm = /^([\d ]+?)(?:([.,])(\d+))?$/.exec(body)
    if (!sm || !GROUPED_SPACE.test(sm[1]!)) return fail('format', `"${input}" groups digits unevenly`)
    intPart = sm[1]!.replace(/ /g, '')
    fracPart = sm[3] ?? ''
    body = ''
  } else {
    const dots = body.split('.').length - 1
    const commas = body.split(',').length - 1
    if (dots === 0 && commas === 0) {
      intPart = body
    } else if (dots > 0 && commas > 0) {
      // Both present: the LAST one is the decimal mark and appears once; the other groups.
      const dec = body.lastIndexOf('.') > body.lastIndexOf(',') ? '.' : ','
      const grp = dec === '.' ? ',' : '.'
      const [head, tail, ...more] = body.split(dec)
      if (more.length > 0 || !tail || !/^\d+$/.test(tail)) return fail('format', `"${input}" has more than one decimal mark`)
      if (!(grp === '.' ? GROUPED_DOT : GROUPED_COMMA).test(head!)) {
        return fail('format', `"${input}" groups digits unevenly`)
      }
      intPart = head!.split(grp).join('')
      fracPart = tail
    } else {
      const sep = dots > 0 ? '.' : ','
      const count = dots + commas
      if (count > 1) {
        // Several of one mark: they can only be groups.
        if (!(sep === '.' ? GROUPED_DOT : GROUPED_COMMA).test(body)) {
          return fail('format', `"${input}" groups digits unevenly`)
        }
        intPart = body.split(sep).join('')
      } else {
        const [head, tail] = body.split(sep) as [string, string]
        if (!/^\d*$/.test(head) || !/^\d+$/.test(tail)) return fail('format', `"${input}" is not a number`)
        const couldGroup = /^[1-9]\d{0,2}$/.test(head) && tail.length === 3
        if (couldGroup && sep === ',') {
          // vi reads "1,000" as one; en reads it as a thousand. Refuse.
          return fail('ambiguous', `"${input}" reads as ${head},${tail} or ${head}${tail} — write ${head}.${tail} or ${head},${tail.replace(/0+$/, '') || '0'}`)
        }
        if (couldGroup && sep === '.') {
          // vi: a single dot before exactly three digits IS a thousands group — as Intl prints 2500.
          intPart = head + tail
        } else {
          intPart = head === '' ? '0' : head
          fracPart = tail
        }
      }
    }
  }

  if (!/^\d+$/.test(intPart) || !/^\d*$/.test(fracPart)) return fail('format', `"${input}" is not a number`)

  // Precision a float64 cannot keep — refused, never silently rounded.
  const frac = fracPart.replace(/0+$/, '')
  if (frac === '') {
    if (BigInt(intPart) > BigInt(Number.MAX_SAFE_INTEGER)) {
      return fail('precision', `"${input}" has more digits than a number can hold exactly`, Number.MAX_SAFE_INTEGER)
    }
  } else {
    const significant = (intPart.replace(/^0+/, '') + frac).replace(/^0+/, '')
    if (significant.length > 15) {
      return fail('precision', `"${input}" has more significant digits than a number can hold exactly`, 15)
    }
  }
  const n = Number(`${sign}${intPart}${frac ? `.${frac}` : ''}`)
  return { ok: true, value: n === 0 ? 0 : n }
}

// ── Dates ──────────────────────────────────────────────────────────────────

const pad = (n: number) => String(n).padStart(2, '0')

function day(y: number, m: number, d: number, input: string): ParseResult {
  const iso = `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`
  return isIsoDate(iso) ? { ok: true, value: iso } : fail('no-such-day', `"${input}" is not a day on the calendar`)
}

function parseDate(input: string): ParseResult {
  const s = input.replace(/\s+/g, ' ')
  let m: RegExpExecArray | null
  // Four digits first — year/month/day, one reading.
  if ((m = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/.exec(s))) return day(+m[1]!, +m[3]!, +m[4]!, input)
  // Vietnamese order — day/month/year, one separator throughout.
  if ((m = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})$/.exec(s))) return day(+m[4]!, +m[3]!, +m[1]!, input)
  // As a decree writes it: "ngày 12 tháng 9 năm 2026".
  if ((m = /^ngày (\d{1,2}) tháng (\d{1,2}) năm (\d{4})$/iu.exec(s))) return day(+m[3]!, +m[2]!, +m[1]!, input)
  // Two-digit year: which century?
  if (/^\d{1,2}([-/.])\d{1,2}\1\d{2}$/.test(s)) {
    return fail('ambiguous', `"${input}" does not say which century — write the year in full`)
  }
  // Eight bare digits: yyyymmdd or ddmmyyyy?
  if (/^\d{8}$/.test(s)) return fail('ambiguous', `"${input}" does not say which digits are the day — separate them`)
  return fail('format', `"${input}" is not a date — write it as dd/mm/yyyy`)
}

// ── Date-times ─────────────────────────────────────────────────────────────

const TIME = String.raw`(\d{1,2})(?::(\d{2})(?::(\d{2}))?|h(\d{2})?)(?: ?(sa|ch|am|pm))?`
const DATE_THEN_TIME = new RegExp(`^(.+?) ${TIME}$`, 'iu')
const TIME_THEN_DATE = new RegExp(`^${TIME} (.+)$`, 'iu')

function parseDateTime(input: string, opts: ParseOptions): ParseResult {
  const s = input.replace(/\s+/g, ' ')
  if (isIsoDateTime(s)) {
    const zoned = /(Z|[+-]\d{2}(:?\d{2})?)$/.test(s) || !/[T ]\d{2}:/.test(s)
    return { ok: true, value: zoned || !opts.offset ? s : `${s}${opts.offset}` }
  }

  let datePart: string
  let t: string[]
  let m: RegExpExecArray | null
  if ((m = DATE_THEN_TIME.exec(s))) {
    datePart = m[1]!
    t = m.slice(2)
  } else if ((m = TIME_THEN_DATE.exec(s))) {
    datePart = m[6]!
    t = m.slice(1, 6)
  } else {
    // A day alone is a datetime of reduced precision; anything else is not a datetime.
    const d = parseDate(s)
    return d.ok ? d : d.reason === 'format' ? fail('format', `"${input}" is not a date and time — write dd/mm/yyyy hh:mm`) : d
  }

  const d = parseDate(datePart)
  if (!d.ok) return d
  const [hh, mm, ss, hm, mer] = t as [string, string | undefined, string | undefined, string | undefined, string | undefined]
  let hour = +hh
  const minute = +(mm ?? hm ?? '0')
  const second = ss === undefined ? undefined : +ss
  if (mer) {
    const pm = /^(ch|pm)$/i.test(mer)
    if (hour < 1 || hour > 12) return fail('no-such-time', `"${input}": a 12-hour clock runs 1–12`)
    hour = pm ? (hour % 12) + 12 : hour % 12
  }
  if (hour > 23 || minute > 59 || (second !== undefined && second > 59)) {
    return fail('no-such-time', `"${input}" is not a time on the clock`)
  }
  const time = `${pad(hour)}:${pad(minute)}${second === undefined ? '' : `:${pad(second)}`}`
  return { ok: true, value: `${d.value as string}T${time}${opts.offset ?? ''}` }
}
