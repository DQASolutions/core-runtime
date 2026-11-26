// Đẩy một PHẦN của ConditionExpr xuống SQL — lọc thô ở kho, lọc tinh ở JS.
//
// ═══════════════════════════════════════════════════════════════════════════
// VÌ SAO KHÔNG DỊCH TOÀN BỘ SANG SQL
//
//   `matchesProperties` là bản tham chiếu và phải giữ nguyên (QG-5: cùng kết
//   quả với InMemoryAdapter). Nhưng ngữ nghĩa JS KHÔNG tương đương SQL ở ba chỗ:
//
//     ① Khoá thiếu.  JS: data[k] === undefined, nên `!=` cho TRUE.
//                    SQL: NULL <> 'x' cho NULL, dòng bị loại. → LỆCH
//     ② JSON null.   JS: null === null cho TRUE.
//                    SQL: NULL = NULL cho NULL. → LỆCH
//     ③ Thứ tự chuỗi. JS so theo mã UTF-16. Postgres so theo đối chiếu (ICU).
//                    Với tiếng Việt hai thứ tự KHÁC NHAU. → LỆCH ở > < >= <=
//
//   Dịch bừa là đổi kết quả nghiệp vụ mà không ai thấy. Nên ở đây SQL chỉ được
//   phép là PHÉP LỌC THÔ AN TOÀN: nó có thể trả về THỪA dòng, nhưng TUYỆT ĐỐI
//   không được thiếu dòng nào mà JS sẽ giữ. Sau đó JS lọc lại y như cũ.
//
//   Hệ quả: kết quả cuối cùng KHÔNG ĐỔI — chỉ khác là kho không còn phải trả cả
//   bảng về, và những chỉ mục bộ phận trên `data->>'…'` bắt đầu được dùng.
//
// ⭐ QUY TẮC AN TOÀN — mọi thay đổi sau này phải giữ
//
//   Bỏ bớt một điều kiện thì tập kết quả RỘNG ra → an toàn.
//   Thêm một điều kiện thì tập kết quả HẸP lại → CHỈ được làm khi chứng minh
//   được nó trùng khít ngữ nghĩa JS.
//
//   Vì thế: `and` bỏ được vế không dịch nổi; `or` thì KHÔNG — bỏ một nhánh của
//   `or` là mất dòng. `not` để nguyên, không đẩy.
// ═══════════════════════════════════════════════════════════════════════════
import type { CompareOp, ConditionExpr, ValueRef } from '../../types/index.js'

export interface SqlFilter {
  /** Mệnh đề đặt sau AND. Đã bọc ngoặc, an toàn để ghép. */
  readonly sql: string
  /** Tham số, theo đúng thứ tự chỉ số đã sinh. */
  readonly params: readonly unknown[]
}

/** Chỉ đẩy được giá trị mà so sánh SQL trùng khít `===` của JS. */
function pushableLiteral(ref: ValueRef): { ok: true; value: string | boolean } | { ok: false } {
  if (ref.kind !== 'literal') return { ok: false }
  // ⛔ SỐ KHÔNG ĐẨY. JS `5 === 5.0` là TRUE; jsonb giữ nguyên chữ viết nên
  //    '5'::jsonb = '5.0'::jsonb là FALSE. Để JS lọc cho chắc.
  if (typeof ref.value === 'string' || typeof ref.value === 'boolean') {
    return { ok: true, value: ref.value }
  }
  return { ok: false }
}

/** Tên thuộc tính, chỉ khi ValueRef trỏ đúng thực thể đang truy vấn. */
function pushableProperty(ref: ValueRef, entityType: string): string | null {
  if (ref.kind !== 'property') return null
  if (ref.entity !== entityType) return null
  return ref.name
}

interface Ctx {
  readonly entityType: string
  readonly params: unknown[]
  /** Chỉ số tham số kế tiếp — đã tính cả $1 dành cho entity_type. */
  nextIndex: number
}

function bind(ctx: Ctx, value: unknown): string {
  ctx.params.push(value)
  return `$${ctx.nextIndex++}`
}

function compileCompare(
  left: ValueRef,
  cmp: CompareOp,
  right: ValueRef,
  ctx: Ctx,
): string | null {
  // ⛔ > < >= <= không đẩy: thứ tự chuỗi của JS khác đối chiếu của Postgres.
  if (cmp !== '=' && cmp !== '!=') return null

  // `=` và `!=` đối xứng, nên thử cả hai chiều.
  let name = pushableProperty(left, ctx.entityType)
  let lit = pushableLiteral(right)
  if (name === null || !lit.ok) {
    name = pushableProperty(right, ctx.entityType)
    lit = pushableLiteral(left)
  }
  if (name === null || !lit.ok) return null

  // ⭐ Dùng `data -> khoá` (ra jsonb) chứ KHÔNG dùng `->>` (ra text):
  //    · khoá thiếu    → SQL NULL
  //    · JSON null     → 'null'::jsonb, KHÁC SQL NULL
  //    · '5' và 5      → '"5"'::jsonb và '5'::jsonb, khác nhau — đúng như `===`
  //
  //    Và dùng IS [NOT] DISTINCT FROM để khoá thiếu cho ra TRUE/FALSE thay vì
  //    NULL — khớp đúng hành vi `undefined !== 'x'` của JS.
  const keyParam = bind(ctx, name)
  const valParam = bind(ctx, JSON.stringify(lit.value))
  const op = cmp === '=' ? 'IS NOT DISTINCT FROM' : 'IS DISTINCT FROM'
  return `(data -> ${keyParam}) ${op} ${valParam}::jsonb`
}

function compile(expr: ConditionExpr, ctx: Ctx): string | null {
  switch (expr.op) {
    case 'and': {
      // Bỏ được vế không dịch nổi — kết quả chỉ rộng ra.
      const parts = expr.clauses.map((c) => compile(c, ctx)).filter((s): s is string => s !== null)
      return parts.length === 0 ? null : `(${parts.join(' AND ')})`
    }
    case 'or': {
      // KHÔNG bỏ được vế nào — thiếu một nhánh là mất dòng.
      const parts: string[] = []
      for (const c of expr.clauses) {
        const s = compile(c, ctx)
        if (s === null) return null
        parts.push(s)
      }
      return parts.length === 0 ? null : `(${parts.join(' OR ')})`
    }
    case 'not':
      // Để nguyên cho JS. Phủ định một phép lọc thô KHÔNG còn là phép lọc thô.
      return null
    case 'compare':
      return compileCompare(expr.left, expr.cmp, expr.right, ctx)
    default:
      // exists / absent / count — `matchesProperties` sẽ ném lỗi đúng chỗ của nó.
      return null
  }
}

/**
 * Dịch phần đẩy được của `expr` thành một mệnh đề WHERE bổ sung.
 *
 * @param firstParamIndex chỉ số tham số đầu tiên còn trống (câu lệnh gọi đã
 *        dùng $1 cho entity_type thì truyền 2).
 * @returns `null` khi không có gì đẩy được — người gọi cứ quét như cũ.
 */
export function compilePropertyFilter(
  expr: ConditionExpr | null,
  entityType: string,
  firstParamIndex: number,
): SqlFilter | null {
  if (expr === null) return null
  const ctx: Ctx = { entityType, params: [], nextIndex: firstParamIndex }
  const sql = compile(expr, ctx)
  if (sql === null) return null
  return { sql, params: ctx.params }
}
