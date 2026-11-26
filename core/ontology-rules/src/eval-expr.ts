// EVAL-EXPR — the interpreter for rules-as-DATA. Turns an ExprNode JSON tree
// into a verdict by DISPATCHING each op to a core-op (core-ops.ts). No new logic
// lives here: this is the thin layer that lets a rule encoded as JSON run on the
// exact same closed primitive basis a hand-written TypeScript `khi` composes from.
//
//   NL → AI parse → ExprNode (DATA) → validateRuleSpec (deterministic) →
//   evalExpr (deterministic) → boolean verdict.
//
// Determinism & termination: the IR is a finite tree, sets are finite, `reach` is
// depth-bounded ⇒ evaluation always halts. A visit budget guards pathological IR.
//
// SCOPE / bound variables — the one non-trivial part. An expression is evaluated
// against the rule's focus instance `self`. Set operations (filter/sum/any/…)
// evaluate their inner sub-expression once PER ELEMENT, binding that element to
// `it`. So inside `filter`, a `prop` with no explicit node reads the element;
// outside, it reads `self`. This is what makes "Σ subledger entries WHERE
// side=debit" expressible as DATA.

import type { Instance, FunctionIO, Value } from '@dqa-ai-solutions/ontology-model'
import * as ops from './core-ops.js'
import { rule, type RuleSpec } from './fn.js'
import { assertRuleIRSchema } from './rule-schema.js'

export type Scalar = number | string | boolean
type EvalValue = Scalar | Instance | Instance[]

/** A node read by `call` to reach a named Tầng-M macro/compute by name. */
export type ComputeFn = (args: Record<string, Value>, io: FunctionIO) => Value | Promise<Value>

/** Resolve a named, effective-dated parameter: (key, asOf YYYY-MM-DD) → value then. */
export type ParamResolver = (key: string, asOf: string) => number | undefined

/** One LawParameter row (effective-dated). Multiple rows per key = its history. */
export interface LawParameterRow { key: string; value: number; effectiveFrom?: string; effectiveTo?: string }

/** Build a {@link ParamResolver} from LawParameter rows — picks the row whose
 *  [effectiveFrom, effectiveTo) window contains `asOf` (latest effectiveFrom wins). */
export function paramResolver(rows: LawParameterRow[]): ParamResolver {
  return (key, asOf) =>
    rows
      .filter((r) => r.key === key && (!r.effectiveFrom || r.effectiveFrom <= asOf) && (!r.effectiveTo || asOf < r.effectiveTo))
      .sort((a, b) => (b.effectiveFrom ?? '').localeCompare(a.effectiveFrom ?? ''))[0]?.value
}

/** The rule condition as DATA. `op` is the discriminant. A boolean-valued tree
 *  encodes the VIOLATION condition (true ⇒ the rule fires), matching `khi`. */
export type ExprNode =
  // ── access ──
  | { op: 'lit'; value: Scalar }
  | { op: 'self' }
  | { op: 'it' }
  | { op: 'prop'; field: string; node?: ExprNode }            // node defaults to it ?? self
  // ── navigation ──
  | { op: 'rel'; rel: string; node?: ExprNode }               // node defaults to it ?? self → NodeSet
  | { op: 'find'; entityType: string }                        // → all instances of a type
  // ── set → set (σ) ──
  | { op: 'filter'; set: ExprNode; where: ExprNode; as?: string }
  // ── set → scalar (γ) ──
  | { op: 'sum'; set: ExprNode; value: ExprNode; as?: string }
  | { op: 'count'; set: ExprNode; where?: ExprNode; as?: string }
  | { op: 'min' | 'max' | 'avg'; set: ExprNode; value: ExprNode; as?: string }
  | { op: 'sumif'; set: ExprNode; where: ExprNode; value: ExprNode; as?: string }   // Excel SUMIF: Σ value over set matching where
  | { op: 'countif'; set: ExprNode; where: ExprNode; as?: string }                  // Excel COUNTIF
  // ── arithmetic (+ − × ÷) ──
  | { op: 'add' | 'sub' | 'mul' | 'div'; left: ExprNode; right: ExprNode }
  | { op: 'abs'; arg: ExprNode }
  // ── compare (with optional tolerance for = / !=) ──
  | { op: 'compare'; cmp: '=' | '!=' | '<' | '<=' | '>' | '>='; left: ExprNode; right: ExprNode; tolerance?: number }
  // ── logic ──
  | { op: 'and' | 'or'; children: ExprNode[] }
  | { op: 'not'; child: ExprNode }
  // ── quantify (∃ / ∀) ──
  | { op: 'any' | 'all'; set: ExprNode; where: ExprNode; as?: string }
  | { op: 'exists' | 'empty'; set: ExprNode }
  // ── conditional ──
  | { op: 'if'; cond: ExprNode; then: ExprNode; else: ExprNode }
  // ── boundary primitives ──
  | { op: 'reach'; rel: string; node?: ExprNode }
  | { op: 'daysBetween'; from: ExprNode; to: ExprNode }
  | { op: 'startsWith'; text: ExprNode; prefix: ExprNode }
  | { op: 'textContains'; text: ExprNode; value: ExprNode }
  | { op: 'num' | 'text' | 'size' | 'money'; arg: ExprNode }
  | { op: 'join'; set: ExprNode; value: ExprNode; sep?: string; as?: string }
  | { op: 'var'; name: string }
  | { op: 'concat'; parts: ExprNode[] }
  | { op: 'incoming'; rel: string; node?: ExprNode }
  | { op: 'left'; text: ExprNode; n: ExprNode }
  | { op: 'contains'; field: string; value: Scalar; node?: ExprNode }   // value ∈ node.field (array prop)
  | { op: 'param'; key: string }   // named effective-dated parameter (law threshold as data)
  // ── sugar (back-compat with the meta-rules vocabulary) → desugar to rel+γ ──
  | { op: 'sumNeighbors'; rel: string; field: string }
  | { op: 'countNeighbors'; rel: string }
  | { op: 'hasNeighbors'; rel: string }
  // ── escape to a named Tầng-M macro/compute ──
  | { op: 'call'; name: string; args?: Record<string, ExprNode> }

export interface EvalCtx {
  /** The rule's focus instance — the thing being swept. */
  self: Instance
  io: FunctionIO
  /** Current iteration element, bound inside set operations. */
  it?: Instance
  /** Phần tử vòng lặp ĐƯỢC ĐẶT TÊN (`as`), tra bằng op `var`.
   *  VÌ SAO CẦN: `it` là MỘT ô, nên vòng lặp trong che vòng lặp ngoài. Khuôn phổ biến nhất của phép
   *  cộng cấp kỳ — "cộng CHỈ tài khoản LÁ" = với mỗi tài khoản, hỏi có tài khoản nào khác lấy nó làm
   *  tiền tố không — vì thế không khai báo được, và mọi luật loại đó buộc phải viết bằng mã tay. */
  vars?: Record<string, Instance>
  /** Named computes reachable via `call` (the Tầng-M bridge). */
  computes?: Map<string, ComputeFn>
  /** Review/as-of date (YYYY-MM-DD) for resolving effective-dated `param` values. */
  asOf?: string
  /** Resolver for `param` ops — built from LawParameter data. */
  params?: ParamResolver
  /** Visit budget guard (mutated during eval). */
  budget?: { left: number }
}

export class EvalError extends Error {}

// Budget = số lần thăm node evalExpr cho MỘT lần đánh giá rule trên MỘT instance (ctx tạo mới mỗi instance).
// 100k quá thấp cho sổ cả năm thật: rule trên entity nhỏ aggregate qua tập lớn (vd sumif qua 100k+ bút toán)
// tiêu O(M) visit/instance → vượt 100k → ném oan. Nâng 10M: dư cho O(N×M) hợp lệ, VẪN chặn sớm IR
// pathological/vòng lặp (10M ≈ <1s). Rule self-join O(M²) mức chứng từ đã defer (DEFER_TYPES) nên không rơi vào đây.
const DEFAULT_BUDGET = 10_000_000

/** Evaluate an ExprNode to its value. */
export async function evalExpr(node: ExprNode, ctx: EvalCtx): Promise<EvalValue> {
  const budget = ctx.budget ?? (ctx.budget = { left: DEFAULT_BUDGET })
  if (budget.left-- <= 0) throw new EvalError('evaluation budget exceeded')

  switch (node.op) {
    // ── access ──
    case 'lit':
      return node.value
    case 'self':
      return ctx.self
    case 'it':
      if (!ctx.it) throw new EvalError('`it` used outside a set operation')
      return ctx.it
    case 'var': {
      const v = ctx.vars?.[node.name]
      if (!v) throw new EvalError(`biến "${node.name}" chưa được ràng buộc — thiếu \`as: "${node.name}"\` ở phép duyệt tập bao ngoài`)
      return v
    }
    case 'prop': {
      const target = node.node ? await evalNode(node.node, ctx) : (ctx.it ?? ctx.self)
      const v = target.data[node.field]
      // Numbers stay numbers; everything else surfaces as-is (text/bool) — leaf coercion
      // happens at the consuming op (evalNum/evalScalar), keeping prop honest.
      return (v ?? null) as Scalar
    }

    // ── navigation ──
    case 'rel': {
      const target = node.node ? await evalNode(node.node, ctx) : (ctx.it ?? ctx.self)
      return ops.rel(ctx.io, target, node.rel)
    }
    case 'find':
      return ops.all_of(ctx.io, node.entityType)

    // ── set → set ──
    case 'filter':
      return ops.filter(await evalSet(node.set, ctx), perElemBool(node.where, ctx, node.as))

    // ── set → scalar ──
    case 'sum':
      return ops.sum(await evalSet(node.set, ctx), perElemNum(node.value, ctx, node.as))
    case 'count':
      return ops.count(await evalSet(node.set, ctx), node.where ? perElemBool(node.where, ctx, node.as) : undefined)
    case 'sumif': // Excel SUMIF = sum(filter(set, where), value)
      return ops.sum(await ops.filter(await evalSet(node.set, ctx), perElemBool(node.where, ctx, node.as)), perElemNum(node.value, ctx, node.as))
    case 'countif': // Excel COUNTIF = count(set, where)
      return ops.count(await evalSet(node.set, ctx), perElemBool(node.where, ctx, node.as))
    case 'min':
      return (await ops.min(await evalSet(node.set, ctx), perElemNum(node.value, ctx, node.as))) ?? 0
    case 'max':
      return (await ops.max(await evalSet(node.set, ctx), perElemNum(node.value, ctx, node.as))) ?? 0
    case 'avg':
      return (await ops.avg(await evalSet(node.set, ctx), perElemNum(node.value, ctx, node.as))) ?? 0

    // ── arithmetic ──
    case 'add':
      return (await evalNum(node.left, ctx)) + (await evalNum(node.right, ctx))
    case 'sub':
      return (await evalNum(node.left, ctx)) - (await evalNum(node.right, ctx))
    case 'mul':
      return (await evalNum(node.left, ctx)) * (await evalNum(node.right, ctx))
    case 'div': {
      const d = await evalNum(node.right, ctx)
      if (d === 0) throw new EvalError('division by zero')
      return (await evalNum(node.left, ctx)) / d
    }
    case 'abs':
      return ops.abs(await evalNum(node.arg, ctx))

    // ── compare ──
    case 'compare': {
      const l = await evalScalar(node.left, ctx)
      const r = await evalScalar(node.right, ctx)
      const tol = node.tolerance ?? 0
      if (typeof l === 'number' && typeof r === 'number') {
        switch (node.cmp) {
          case '=':  return ops.eq(l, r, tol)
          case '!=': return ops.ne(l, r, tol)
          case '<':  return ops.lt(l, r)
          case '<=': return ops.le(l, r)
          case '>':  return ops.gt(l, r)
          case '>=': return ops.ge(l, r)
        }
      }
      // non-numeric: only equality is meaningful
      const a = String(l), b = String(r)
      if (node.cmp === '=')  return a === b
      if (node.cmp === '!=') return a !== b
      throw new EvalError(`order comparison "${node.cmp}" on non-numeric values`)
    }

    // ── logic ──
    case 'and': {
      for (const c of node.children) if (!(await evalBool(c, ctx))) return false
      return true
    }
    case 'or': {
      for (const c of node.children) if (await evalBool(c, ctx)) return true
      return false
    }
    case 'not':
      return !(await evalBool(node.child, ctx))

    // ── quantify ──
    case 'any':
      return ops.any(await evalSet(node.set, ctx), perElemBool(node.where, ctx, node.as))
    case 'all':
      return ops.all(await evalSet(node.set, ctx), perElemBool(node.where, ctx, node.as))
    case 'exists':
      return ops.exists(await evalSet(node.set, ctx))
    case 'empty':
      return ops.isEmpty(await evalSet(node.set, ctx))

    // ── conditional ──
    case 'if':
      return (await evalBool(node.cond, ctx)) ? evalExpr(node.then, ctx) : evalExpr(node.else, ctx)

    // ── boundary ──
    case 'reach': {
      const target = node.node ? await evalNode(node.node, ctx) : (ctx.it ?? ctx.self)
      return ops.reach(ctx.io, target, node.rel)
    }
    case 'daysBetween':
      return ops.daysBetween(await evalText(node.from, ctx), await evalText(node.to, ctx))
    case 'startsWith':
      return ops.startsWith(await evalText(node.text, ctx), await evalText(node.prefix, ctx))
    // ĐI CẠNH NGƯỢC CHIỀU. Cạnh khai một chiều (`SourceDocument → JournalEntry`), nhưng câu hỏi soát xét
    // thường đứng ở ĐẦU KIA: "bút toán này có chứng từ nào trỏ tới không". Không có phép này thì mọi luật
    // hỏi ngược đều phải viết bằng mã tay — và đó chính là chỗ họ luật truy-vết đang mắc.
    case 'incoming': {
      const n = node.node ? await evalNode(node.node, ctx) : (ctx.it ?? ctx.self)
      const io = ctx.io as FunctionIO & { incoming?: (id: string, rel: string) => Promise<Instance[]> }
      if (!io.incoming) throw new EvalError('op `incoming` cần host cấp `io.incoming(id, rel)` — chưa nối')
      return io.incoming(n.id, node.rel)
    }
    case 'concat': {
      const parts: unknown[] = []
      for (const e of node.parts) parts.push(await evalExpr(e, ctx))
      return ops.concatText(parts)
    }
    case 'join': {
      const set = await evalSet(node.set, ctx)
      const vals: unknown[] = []
      for (const e of set) vals.push(await evalExpr(node.value, bind(ctx, e, node.as)))
      return ops.joinText(vals, node.sep ?? ', ')
    }
    case 'num':
      return ops.toNum(await evalExpr(node.arg, ctx))
    case 'text':
      return ops.toText(await evalExpr(node.arg, ctx))
    case 'money':
      return ops.money(await evalExpr(node.arg, ctx))
    case 'size':
      return ops.sizeOf(await evalExpr(node.arg, ctx))
    case 'textContains':
      return ops.textContains(await evalText(node.text, ctx), await evalText(node.value, ctx))
    case 'left':
      return ops.left(await evalText(node.text, ctx), Number(await evalExpr(node.n, ctx)))
    case 'contains': {
      const target = node.node ? await evalNode(node.node, ctx) : (ctx.it ?? ctx.self)
      return ops.contains(target, node.field, node.value)
    }
    case 'param': {
      if (!ctx.params) throw new EvalError('param resolver not wired (no LawParameter data)')
      const v = ctx.params(node.key, ctx.asOf ?? '')
      if (v === undefined) throw new EvalError(`param "${node.key}" has no value effective at ${ctx.asOf || '(no asOf)'}`)
      return v
    }

    // ── sugar → desugar to the orthogonal ops ──
    case 'sumNeighbors':
      return ops.sum(await ops.rel(ctx.io, ctx.it ?? ctx.self, node.rel), node.field)
    case 'countNeighbors':
      return ops.count(await ops.rel(ctx.io, ctx.it ?? ctx.self, node.rel))
    case 'hasNeighbors':
      return ops.exists(await ops.rel(ctx.io, ctx.it ?? ctx.self, node.rel))

    // ── escape to a named compute ──
    case 'call': {
      const fn = ctx.computes?.get(node.name)
      if (!fn) throw new EvalError(`compute "${node.name}" not registered`)
      const args: Record<string, Value> = {}
      for (const [k, v] of Object.entries(node.args ?? {})) args[k] = (await evalScalar(v, ctx)) as Value
      return (await fn(args, ctx.io)) as EvalValue
    }

    default:
      throw new EvalError(`unknown op "${(node as { op: string }).op}"`)
  }
}

// ── typed evaluation wrappers ───────────────────────────────────────────────────

async function evalScalar(node: ExprNode, ctx: EvalCtx): Promise<Scalar> {
  const v = await evalExpr(node, ctx)
  if (Array.isArray(v) || (v !== null && typeof v === 'object'))
    throw new EvalError(`expected a scalar, got a ${Array.isArray(v) ? 'set' : 'node'}`)
  return v as Scalar
}

async function evalNum(node: ExprNode, ctx: EvalCtx): Promise<number> {
  return Number((await evalScalar(node, ctx)) ?? 0)
}

async function evalText(node: ExprNode, ctx: EvalCtx): Promise<string> {
  return String((await evalScalar(node, ctx)) ?? '')
}

export async function evalBool(node: ExprNode, ctx: EvalCtx): Promise<boolean> {
  return Boolean(await evalExpr(node, ctx))
}

async function evalNode(node: ExprNode, ctx: EvalCtx): Promise<Instance> {
  const v = await evalExpr(node, ctx)
  if (v === null || typeof v !== 'object' || Array.isArray(v))
    throw new EvalError('expected a node')
  return v as Instance
}

async function evalSet(node: ExprNode, ctx: EvalCtx): Promise<Instance[]> {
  const v = await evalExpr(node, ctx)
  if (!Array.isArray(v)) throw new EvalError('expected a node set')
  return v
}

// per-element closures: evaluate an inner expression with `it` bound to the element
/** Ngữ cảnh cho MỘT phần tử: luôn ràng `it`, và ràng thêm tên nếu phép duyệt khai `as`.
 *  Giữ `it` cùng lúc để mọi luật đã viết chạy y nguyên — `as` là thêm, không phải thay. */
const bind = (ctx: EvalCtx, e: Instance, as?: string): EvalCtx =>
  as ? { ...ctx, it: e, vars: { ...ctx.vars, [as]: e } } : { ...ctx, it: e }
const perElemBool = (inner: ExprNode, ctx: EvalCtx, as?: string) => (e: Instance): Promise<boolean> =>
  evalBool(inner, bind(ctx, e, as))
const perElemNum = (inner: ExprNode, ctx: EvalCtx, as?: string) => (e: Instance): Promise<number> =>
  evalNum(inner, bind(ctx, e, as))

// ── rule-as-data → runnable rule ────────────────────────────────────────────────

/** A rule encoded entirely as DATA — the boolean `expr` is the violation condition. */
export interface RuleIR {
  on: string
  id: string
  severity?: string
  category?: string
  /** Schema version this rule was authored against (optional; checked at load). */
  schemaVersion?: number
  /** Lifecycle state. The runtime loader (`loadRuleStore`) runs only `active`
   *  rules (or rules with no status set); draft/pending/deprecated are skipped. */
  status?: 'draft' | 'pending-review' | 'active' | 'deprecated'
  /** Violation condition: evaluates to true ⇒ the rule fires on that instance. */
  expr: ExprNode
  /** Optional rich-output template: when the rule fires, build a Finding from the
   *  instance. `message` is a template with `{field}` / `{field|vnd}` placeholders
   *  (vnd = vi-VN grouped integer); label/delta are evaluated expressions. */
  finding?: {
    label?: ExprNode
    delta?: ExprNode
    /** Mức độ theo CA (biểu thức trả về 'critical'|'warning'|'info'), đè mức tĩnh của luật. */
    severity?: ExprNode
    /** Named expressions evaluated in the rule's own context, then available to `message`
     *  as `{name}` / `{name|vnd}`. WHY: `delta` could always be COMPUTED, but the sentence could
     *  only read properties off the anchor node — so a rule anchored on a node that carries no
     *  figures (a period, a company) could detect a 1.9bn discrepancy and still be unable to say
     *  the number. A rule that fires without stating what it saw is a rule nobody can act on. */
    values?: Record<string, ExprNode>
    message: string
  }
}

/** Render a finding message template: `{field}` → instance property, `{field|vnd}`
 *  → vi-VN grouped integer (matches the hand-written rules' formatting). */
function renderTemplate(template: string, self: Instance, values?: Record<string, unknown>): string {
  const EMPTY = ' '                                   // dấu chỗ trường rỗng — không có trong dữ liệu thật
  const out = template.replace(/\{([A-Za-z0-9_]+)(\|vnd)?\}/g, (_m, name: string, vnd?: string) => {
    // `values` THẮNG thuộc tính node: khai tên trùng là cố ý ghi đè, không phải tai nạn.
    const v = values && name in values ? values[name] : self.data[name]
    if (vnd) return Math.round(Number(v ?? 0)).toLocaleString('vi-VN')
    // Số lẻ in thẳng ra nhiễu dấu phẩy động: 0,50421 kg thành «0.5042099999999999». Cắt còn 4 số lẻ rồi
    // bỏ số 0 thừa. SỐ NGUYÊN GIỮ NGUYÊN (không chèn dấu phân nhóm) — đổi cách in số nguyên sẽ đổi câu chữ
    // của hàng loạt luật đang chạy, mà chỗ cần phân nhóm đã có `|vnd`.
    if (typeof v === 'number' && Number.isFinite(v) && !Number.isInteger(v)) return String(Number(v.toFixed(4)))
    const s = String(v ?? '')
    return s === '' ? EMPTY : s
  })
  // Trường rỗng để lại vết của CHÍNH phép thay thế: «Mã () số lượng 5  kg». Dọn ở ĐÚNG chỗ nối — theo dấu
  // EMPTY, không quét cả câu.
  //
  // Bản đầu quét cả câu bằng `\s{2,}→' '` và đã BÓP ĐÔI DẤU CÁCH TRONG DỮ LIỆU: tên «NGUYEN  VAN A» (đúng
  // như danh sách cơ quan BHXH ghi) thành «NGUYEN VAN A» — người đọc mang câu này đi đối chiếu thì không
  // khớp. Dọn chữ của người soạn luật thì được; sửa giá trị lấy từ hồ sơ thì không bao giờ.
  return out
    .replace(new RegExp(`\\s*(\\(\\s*${EMPTY}\\s*\\)|«\\s*${EMPTY}\\s*»|\\[\\s*${EMPTY}\\s*\\])`, 'g'), '')  // ngoặc rỗng: bỏ cả cặp
    .replace(new RegExp(`[ \\t]*${EMPTY}`, 'g'), '')                                                          // còn lại: bỏ dấu + khoảng trắng dẫn
    .trim()
}

/** Compile a rule-as-data spec into a runnable {@link RuleSpec}. The resulting
 *  `khi` evaluates `expr` against each swept instance — identical wiring to a
 *  hand-written TypeScript rule, but the logic is JSON the interpreter runs.
 *  When `finding` is set, a fired rule returns a Finding (rich output) instead of
 *  a bare boolean. `computes` (optional) exposes named Tầng-M macros to `call`. */
export interface RuleRuntime {
  computes?: Map<string, ComputeFn>
  params?: ParamResolver
  asOf?: string
}
export function ruleFromIR(ir: RuleIR, rt: RuleRuntime = {}): RuleSpec {
  assertRuleIRSchema(ir) // FIXED-schema gate: a non-conforming rule never compiles/runs
  const finding = ir.finding
  return rule({
    on: ir.on,
    id: ir.id,
    severity: ir.severity,
    category: ir.category,
    khi: async (self, io) => {
      const ctx: EvalCtx = { self, io, computes: rt.computes, params: rt.params, asOf: rt.asOf }
      const fired = await evalBool(ir.expr, ctx)
      if (!fired || !finding) return fired
      // Chỉ tính khi luật ĐÃ NỔ — câu findings của ca không vi phạm thì không ai đọc, mà `values` có
      // thể quét cả một loại (`find`/`join`). Tính sớm là trả giá quét cho từng bản ghi sạch.
      let vals: Record<string, unknown> | undefined
      if (finding.values) {
        vals = {}
        for (const [k, e] of Object.entries(finding.values)) vals[k] = await evalExpr(e, ctx)
      }
      return {
        ...(finding.severity !== undefined ? { severity: String(await evalExpr(finding.severity, ctx)) } : {}),
        ...(finding.label !== undefined ? { label: String(await evalExpr(finding.label, ctx)) } : {}),
        ...(finding.delta !== undefined ? { delta: Number(await evalExpr(finding.delta, ctx)) } : {}),
        message: renderTemplate(finding.message, self, vals),
      }
    },
  })
}
