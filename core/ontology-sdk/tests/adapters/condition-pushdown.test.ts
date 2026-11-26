/**
 * Đẩy điều kiện xuống SQL — phép thử giữ QG-5.
 *
 * Điều phải chứng minh KHÔNG phải "SQL lọc đúng", mà là:
 *
 *   ⭐ SQL không bao giờ loại mất một dòng mà `matchesProperties` sẽ giữ.
 *
 * Vì `queryInstances` vẫn chạy `matchesProperties` sau khi kho trả về, nên chỉ
 * cần tính chất trên là kết quả cuối cùng KHÔNG ĐỔI — dù SQL có trả thừa.
 *
 * Chạy không cần cơ sở dữ liệu: mệnh đề SQL sinh ra được diễn giải lại bằng
 * đúng ngữ nghĩa Postgres (`->`, `IS [NOT] DISTINCT FROM`, `jsonb` so sánh có
 * phân biệt kiểu) rồi đối chiếu với JS trên một tập dữ liệu có đủ các ca hiểm:
 * khoá thiếu · JSON null · chuỗi rỗng · số so với chuỗi cùng chữ · dấu tiếng Việt.
 */
import { describe, it, expect } from 'vitest'
import { compilePropertyFilter } from '../../src/adapters/postgres/condition-sql.js'
import { matchesProperties } from '../../src/shared/condition-match.js'
import type { ConditionExpr } from '../../src/types/index.js'

const ENTITY = 'StaffMember'
const prop = (name: string) => ({ kind: 'property' as const, entity: ENTITY, name })
const lit = (value: string | number | boolean) => ({ kind: 'literal' as const, value })
const cmp = (name: string, op: '=' | '!=' | '>' | '<', value: string | number | boolean): ConditionExpr =>
  ({ op: 'compare', left: prop(name), cmp: op, right: lit(value) })

// ── Ca hiểm: mỗi dòng bịt một chỗ JS và SQL dễ lệch nhau ────────────────────
const ROWS: Record<string, unknown>[] = [
  { communeCode: '01234', status: 'ACTIVE' },
  { communeCode: '01234', status: 'EXEMPT' },
  { communeCode: '09999', status: 'ACTIVE' },
  { communeCode: '01234' }, //                    khoá `status` THIẾU
  { communeCode: '01234', status: null }, //       JSON null
  { communeCode: '01234', status: '' }, //         chuỗi rỗng
  { communeCode: '01234', status: 5 }, //          số 5
  { communeCode: '01234', status: '5' }, //        chuỗi "5" — khác số 5
  { communeCode: '01234', status: true }, //       boolean
  { communeCode: '01234', status: 'Đắk Lắk' }, //  dấu tiếng Việt
  {}, //                                           rỗng hoàn toàn
]

/**
 * Diễn giải mệnh đề SQL sinh ra, theo đúng ngữ nghĩa Postgres.
 * Chỉ hiểu đúng hình dạng mà `condition-sql.ts` sinh ra — thấy hình dạng lạ thì
 * ném lỗi, để phép thử này không âm thầm bỏ qua một nhánh mới thêm vào.
 */
function evalSql(sql: string, params: readonly unknown[], data: Record<string, unknown>): boolean {
  const LEAF = /^\(data -> \$(\d+)\) IS (NOT )?DISTINCT FROM \$(\d+)::jsonb$/
  function walk(expr: string): boolean {
    const e = expr.trim()
    const leaf = LEAF.exec(e)
    if (leaf !== null) {
      const key = params[Number(leaf[1]) - 2] as string
      const wanted = JSON.parse(params[Number(leaf[3]) - 2] as string) as unknown
      // `data -> key` cho SQL NULL khi thiếu khoá; JSON null là 'null'::jsonb.
      const missing = !Object.hasOwn(data, key)
      const actual = missing ? MISSING : data[key]
      // jsonb so sánh có phân biệt kiểu — giống hệt `===` của JS trên vô hướng.
      const same = actual === wanted
      // `IS NOT DISTINCT FROM` = BẰNG · `IS DISTINCT FROM` = KHÁC.
      return leaf[2] === undefined ? !same : same
    }
    if (e.startsWith('(') && e.endsWith(')')) {
      const inner = e.slice(1, -1)
      const parts = splitTop(inner)
      if (parts.op === 'AND') return parts.items.every(walk)
      if (parts.op === 'OR') return parts.items.some(walk)
      return walk(inner)
    }
    throw new Error(`hình dạng SQL chưa được phép thử này hiểu: ${e}`)
  }
  return walk(sql)
}

const MISSING = Symbol('missing')

/** Tách theo AND/OR ở mức ngoặc ngoài cùng. */
function splitTop(s: string): { op: 'AND' | 'OR' | null; items: string[] } {
  const items: string[] = []
  let depth = 0
  let start = 0
  let op: 'AND' | 'OR' | null = null
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++
    else if (s[i] === ')') depth--
    else if (depth === 0) {
      for (const cand of ['AND', 'OR'] as const) {
        if (s.startsWith(` ${cand} `, i)) {
          if (op !== null && op !== cand) throw new Error('trộn AND/OR không ngoặc')
          op = cand
          items.push(s.slice(start, i))
          start = i + cand.length + 2
          i = start - 1
        }
      }
    }
  }
  items.push(s.slice(start))
  return { op, items: op === null ? [s] : items }
}

/** Tính chất phải giữ: SQL giữ lại MỌI dòng mà JS giữ. */
function assertSound(cond: ConditionExpr): void {
  const pushed = compilePropertyFilter(cond, ENTITY, 2)
  for (const row of ROWS) {
    const jsKeeps = matchesProperties(cond, row)
    if (!jsKeeps) continue
    const sqlKeeps = pushed === null ? true : evalSql(pushed.sql, pushed.params, row)
    expect(
      sqlKeeps,
      `SQL loại mất dòng mà JS giữ: ${JSON.stringify(row)} — mệnh đề ${pushed?.sql}`,
    ).toBe(true)
  }
}

/** Kết quả cuối cùng (SQL thô → JS tinh) phải trùng khít với chỉ JS. */
function assertSameResult(cond: ConditionExpr): void {
  const pushed = compilePropertyFilter(cond, ENTITY, 2)
  const jsOnly = ROWS.filter((r) => matchesProperties(cond, r))
  const twoStage = ROWS.filter((r) => (pushed === null ? true : evalSql(pushed.sql, pushed.params, r))).filter(
    (r) => matchesProperties(cond, r),
  )
  expect(twoStage).toEqual(jsOnly)
}

describe('đẩy điều kiện xuống SQL', () => {
  const cases: [string, ConditionExpr][] = [
    ['bằng, chuỗi', cmp('status', '=', 'ACTIVE')],
    ['khác, chuỗi', cmp('status', '!=', 'ACTIVE')],
    ['bằng, chuỗi rỗng', cmp('status', '=', '')],
    ['bằng, boolean', cmp('status', '=', true)],
    ['bằng, có dấu', cmp('status', '=', 'Đắk Lắk')],
    ['bằng, chuỗi "5" không được khớp số 5', cmp('status', '=', '5')],
    ['số — không đẩy, JS lo', cmp('status', '=', 5)],
    ['lớn hơn — không đẩy, thứ tự chuỗi khác nhau', cmp('status', '>', 'M')],
    ['and hai vế đẩy được', { op: 'and', clauses: [cmp('communeCode', '=', '01234'), cmp('status', '=', 'ACTIVE')] }],
    ['and có một vế không đẩy được', { op: 'and', clauses: [cmp('communeCode', '=', '01234'), cmp('status', '>', 'M')] }],
    ['or hai vế đẩy được', { op: 'or', clauses: [cmp('status', '=', 'ACTIVE'), cmp('status', '=', 'EXEMPT')] }],
    ['or có vế không đẩy được — phải bỏ đẩy hoàn toàn', { op: 'or', clauses: [cmp('status', '=', 'ACTIVE'), cmp('status', '>', 'M')] }],
    ['not — không đẩy', { op: 'not', clause: cmp('status', '=', 'ACTIVE') }],
  ]

  for (const [name, cond] of cases) {
    it(`${name} — SQL không loại mất dòng nào JS giữ`, () => assertSound(cond))
    it(`${name} — kết quả cuối cùng không đổi`, () => assertSameResult(cond))
  }

  it('or có vế không đẩy được thì không sinh mệnh đề nào', () => {
    const cond: ConditionExpr = { op: 'or', clauses: [cmp('status', '=', 'ACTIVE'), cmp('status', '>', 'M')] }
    expect(compilePropertyFilter(cond, ENTITY, 2)).toBeNull()
  })

  it('and bỏ được vế không đẩy, giữ vế đẩy được', () => {
    const cond: ConditionExpr = { op: 'and', clauses: [cmp('communeCode', '=', '01234'), cmp('status', '>', 'M')] }
    const pushed = compilePropertyFilter(cond, ENTITY, 2)
    expect(pushed).not.toBeNull()
    expect(pushed?.params).toEqual(['communeCode', '"01234"'])
  })

  it('thuộc tính của thực thể KHÁC thì không đẩy', () => {
    const cond: ConditionExpr = {
      op: 'compare',
      left: { kind: 'property', entity: 'Citizen', name: 'status' },
      cmp: '=',
      right: lit('ACTIVE'),
    }
    expect(compilePropertyFilter(cond, ENTITY, 2)).toBeNull()
  })

  it('chỉ số tham số bắt đầu đúng chỗ người gọi yêu cầu', () => {
    const pushed = compilePropertyFilter(cmp('status', '=', 'ACTIVE'), ENTITY, 2)
    expect(pushed?.sql).toBe('(data -> $2) IS NOT DISTINCT FROM $3::jsonb')
  })
})
