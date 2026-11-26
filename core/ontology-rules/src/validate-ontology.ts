// VALIDATE-ONTOLOGY — ontology soundness for ANY domain. Relationships declare a KIND
// (the invariant between connected values); this module (a) checks structural soundness
// from the declarations, (b) scores reconciliation on a data snapshot, and (c) AUTO-GENERATES
// the definitional reconciliation rules — so "aggregate = Σ leaves" etc. are derived from the
// ontology, not hand-written. Business/legal rules ride on top of a validated ontology.

import { rule, type RuleSpec } from './fn.js'
import { evalBool, type ExprNode, type EvalCtx } from './eval-expr.js'

export type RelKind = 'derivation' | 'composition' | 'correspondence' | 'succession' | 'reference'
export type Fold = 'sum' | 'count' | 'min' | 'max' | 'avg' | 'latest' | 'formula'
export const REL_KINDS: RelKind[] = ['derivation', 'composition', 'correspondence', 'succession', 'reference']

/** One reconciliation (an Excel SUMIF over the related parts):
 *  whole = Σ part.sum  WHERE part.field matches the criterion.
 *  A criterion is `$wholeField` (refers to a property of the whole), a literal, or an array (in-set). */
export interface ReconcileSpec {
  whole: string
  sum: string
  /** Điều kiện trên chính BẢN GHI TỔNG — spec chỉ áp khi khớp. `where` lọc bản ghi CON, `when` gác bản ghi CHA.
   *  Cần vì cột phải cộng đôi khi phụ thuộc bên của bản ghi tổng: chỉ tiêu BCĐKT bên TÀI SẢN đối chiếu với
   *  số dư Nợ, bên NGUỒN VỐN đối chiếu với số dư Có. Không có `when` thì mọi khai báo đều một chiều, và một
   *  chỉ tiêu dư Có sẽ bị báo lệch ĐÚNG BẰNG giá trị của nó — nêu thừa, không phải phát hiện. */
  when?: Record<string, string | number | (string | number)[]>
  /** Dấu áp cho tổng đã cộng (mặc định 1). Cần cho chỉ tiêu TRÌNH BÀY SỐ ÂM — hao mòn luỹ kế dư Có nhưng
   *  hiện trên bảng cân đối là số trừ đi. */
  sign?: 1 | -1
  where?: Record<string, string | number | (string | number)[]>
}
export interface RelDecl {
  name: string
  from: string
  to: string
  kind?: RelKind
  fold?: Fold
  whole?: string
  parts?: string
  match?: { left: string; right: string }
  /** SUMIF reconciliations (per side / filtered). When set, these supersede whole/parts. */
  reconcile?: ReconcileSpec[]
}
export interface OntologyForSoundness {
  entities: { name: string }[]
  relationships: RelDecl[]
}

const STRUCTURAL = (r: RelDecl): boolean => r.kind === 'derivation' || r.kind === 'composition'

// ── (a) STRUCTURAL soundness (schema only) ───────────────────────────────────────
export interface SoundnessReport {
  atomic: string[]
  aggregate: string[]
  reachToLeaf: Record<string, boolean>
  orphans: string[]
  undeclaredKinds: string[]
  unknownKinds: string[]
  recursive: string[]   // self-referential hierarchy (legit — DAG at instance level)
  cycles: string[]      // bad type-level cycles
  ok: boolean
}

export function validateOntologyStructure(o: OntologyForSoundness, opts: { ignore?: RegExp } = {}): SoundnessReport {
  const ents = o.entities.map((e) => e.name)
  const rels = o.relationships
  const isAgg = (t: string): boolean => rels.some((r) => STRUCTURAL(r) && r.from === t)
  const down = (t: string): string[] => rels.filter((r) => STRUCTURAL(r) && r.from === t).map((r) => r.to)
  const aggregate = ents.filter(isAgg)
  const atomic = ents.filter((t) => !isAgg(t))

  const reachToLeaf: Record<string, boolean> = {}
  for (const a of aggregate) {
    const seen = new Set<string>(); const stack = [a]; let reached = false
    while (stack.length) {
      const x = stack.pop()!; if (seen.has(x)) continue; seen.add(x)
      for (const y of down(x)) { if (!isAgg(y)) reached = true; stack.push(y) }
    }
    reachToLeaf[a] = reached
  }

  const inRel = new Set(rels.flatMap((r) => [r.from, r.to]))
  const orphans = ents.filter((t) => !inRel.has(t) && !(opts.ignore?.test(t) ?? false))
  const undeclaredKinds = rels.filter((r) => !r.kind).map((r) => r.name)
  const unknownKinds = rels.filter((r) => r.kind && !REL_KINDS.includes(r.kind)).map((r) => `${r.name}=${r.kind}`)
  const recursive = rels.filter((r) => STRUCTURAL(r) && r.from === r.to).map((r) => r.name)

  const cycles: string[] = []; const color: Record<string, number> = {}
  const dfs = (t: string, path: string[]): void => {
    color[t] = 1
    for (const n of down(t)) {
      if (n === t) continue
      if (color[n] === 1) cycles.push([...path, t, n].join('→'))
      else if (!color[n]) dfs(n, [...path, t])
    }
    color[t] = 2
  }
  for (const a of aggregate) if (!color[a]) dfs(a, [])

  // `ok` = no HARD errors. Orphans (e.g. standalone reference/config entities like
  // LawParameter that rules read by value, not via edges) are WARNINGS, not failures.
  const ok = unknownKinds.length === 0 && cycles.length === 0 && Object.values(reachToLeaf).every(Boolean)
  return { atomic, aggregate, reachToLeaf, orphans, undeclaredKinds, unknownKinds, recursive, cycles, ok }
}

// ── (b) EMPIRICAL reconciliation scoring (on a data snapshot) ────────────────────
// ── (d) DIAGNOSE — actionable findings + a BOUNDED loop (no infinite validate/fix) ──
// category: structural/declaration = fixable by editing the ontology → BLOCKING (must fix or waive);
//           data = waiting for ingestion → PENDING (never blocking, never retried in the loop).
// A waiver (key + reason) accepts a finding consciously → removed from the blocking set.
// Termination: blocking === 0 (NOT "zero findings"). pending + waived may remain.
export interface Diagnosis {
  key: string
  category: 'structural' | 'declaration' | 'data'
  severity: 'error' | 'warn' | 'info'
  blocking: boolean
  waived?: { reason: string }
  issue: string
  cause: string
  fix: string
}
export interface Waiver { key: string; reason?: string }

export function diagnoseOntology(report: SoundnessReport, scores: RelScore[] = [], waivers: Waiver[] = []): Diagnosis[] {
  const wv = new Map(waivers.map((w) => [w.key, w.reason ?? 'accepted']))
  const raw: Omit<Diagnosis, 'waived' | 'blocking'>[] = []

  for (const [t, ok] of Object.entries(report.reachToLeaf))
    if (!ok) raw.push({ key: `reach:${t}`, category: 'structural', severity: 'error', issue: `Aggregate "${t}" does not reach a leaf`, cause: 'no derivation/composition path down to an atomic entity', fix: `add a relationship from ${t} down to its constituent (atomic) entity` })
  for (const c of report.cycles)
    raw.push({ key: `cycle:${c}`, category: 'structural', severity: 'error', issue: `Bad type cycle: ${c}`, cause: 'an aggregate is built from itself indirectly', fix: 'break the cycle — one direction must be the aggregate' })
  for (const u of report.unknownKinds)
    raw.push({ key: `unknownkind:${u}`, category: 'structural', severity: 'error', issue: `Unknown relationship kind: ${u}`, cause: 'kind not in the closed set', fix: 'use one of: derivation | composition | correspondence | succession | reference' })
  for (const u of report.undeclaredKinds)
    raw.push({ key: `undeclared:${u}`, category: 'declaration', severity: 'error', issue: `Relationship "${u}" has no kind`, cause: 'semantics left implicit — validator cannot check it', fix: 'declare its kind (one of the 5)' })
  for (const o of report.orphans)
    raw.push({ key: `orphan:${o}`, category: 'structural', severity: 'warn', issue: `Entity "${o}" is orphan`, cause: 'in no relationship', fix: 'link it, OR waive it if it is standalone reference/config data' })
  for (const s of scores) {
    if (s.score === null) {
      if (s.kind === 'derivation' || s.kind === 'composition' || s.kind === 'correspondence')
        // DATA category: nothing to fix in the ontology — waiting for ingestion. NEVER blocking → no loop.
        raw.push({ key: `nodata:${s.name}`, category: 'data', severity: 'info', issue: `${s.name} (${s.kind}): no data yet`, cause: 'no instances/edges — drill-down empty here', fix: `ingest the source when available (blind spot until then); this does NOT block the ontology` })
    } else if (s.score < 0.99) {
      raw.push({
        key: `recon:${s.name}`, category: 'declaration', severity: s.score < 0.5 ? 'error' : 'warn',
        issue: `${s.name} (${s.kind}) reconciles only ${Math.round(s.score * 100)}% (${s.ok}/${s.checked})`,
        cause: s.kind === 'derivation' ? 'whole ≠ Σ parts — EITHER the declaration is too coarse (sum a SUBSET by side/filter) OR the data has a real mismatch' : 'value ≠ the independent source on some instances',
        fix: s.kind === 'derivation' ? `declare a SUMIF reconcile: [{whole, sum, where:{partField: $wholeProp}}] (per side). If the declaration is already right, this is a DATA mismatch → investigate, or WAIVE with a reason (don't re-loop).` : `investigate, or waive with a reason`,
      })
    }
  }

  // BLOCKING = an unwaived ERROR (structural breakage / reconciliation <50%). warn = advisory
  // (improve when you can), info/data = pending (waiting for ingestion). Neither blocks the loop.
  return raw.map((d) => {
    const reason = wv.get(d.key)
    return { ...d, waived: reason ? { reason } : undefined, blocking: d.severity === 'error' && !reason }
  })
}

/** Loop-termination summary: stop when `blocking === 0`. */
export function diagnosisSummary(d: Diagnosis[]): { blocking: number; pending: number; waived: number; done: boolean } {
  const blocking = d.filter((x) => x.blocking).length
  return { blocking, pending: d.filter((x) => x.category === 'data').length, waived: d.filter((x) => x.waived).length, done: blocking === 0 }
}

export interface OntologyData {
  instances(type: string): { id: string; data: Record<string, unknown> }[]
  neighbors(id: string, rel: string): { id: string; data: Record<string, unknown> }[]
}
export interface RelScore { name: string; kind: RelKind; checked: number; ok: number; score: number | null }

const FOLD: Record<string, (a: number[]) => number> = {
  sum: (a) => a.reduce((s, x) => s + x, 0),
  count: (a) => a.length,
  min: (a) => (a.length ? Math.min(...a) : 0),
  max: (a) => (a.length ? Math.max(...a) : 0),
  avg: (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0),
}

const resolveCrit = (c: string | number, whole: { data: Record<string, unknown> }): unknown =>
  typeof c === 'string' && c.startsWith('$') ? whole.data[c.slice(1)] : c
function matchWhere(part: { data: Record<string, unknown> }, whole: { data: Record<string, unknown> }, where: ReconcileSpec['where']): boolean {
  for (const [field, c] of Object.entries(where ?? {})) {
    const pv = String(part.data[field] ?? '')
    const ok = Array.isArray(c) ? c.some((v) => String(resolveCrit(v, whole)) === pv) : String(resolveCrit(c, whole)) === pv
    if (!ok) return false
  }
  return true
}

/** MỘT bản ghi lệch: tổng khai trên bản ghi cha ≠ Σ số ở các bản ghi con nối vào nó. */
export interface ReconcileMiss { rel: string; from: string; wholeId: string; whole: string; sum: string; declared: number; summed: number; diff: number }
/** Bản ghi tổng KHÔNG spec nào áp (thiếu trường mà `when` gác trên). Phải trả ra, không được lặng lẽ bỏ:
 *  `when` vừa mở ra khả năng một bản ghi trượt qua MỌI spec và trông y hệt như đã kiểm và đạt. */
export interface ReconcileSkipped { rel: string; from: string; wholeId: string }

const specsOf = (r: RelDecl): ReconcileSpec[] => r.reconcile ?? (r.whole && r.parts ? [{ whole: r.whole, sum: r.parts }] : [])

/** Phép so DUY NHẤT cho `kind: derivation` — điểm số và danh sách lệch dùng chung, nên không thể trôi khỏi nhau. */
function missesOf(r: RelDecl, w: { id: string; data: Record<string, unknown> }, parts: { data: Record<string, unknown> }[], tol: number): { misses: ReconcileMiss[]; applied: number } {
  const misses: ReconcileMiss[] = []
  let applied = 0
  for (const s of specsOf(r)) {
    if (s.when && !matchWhere(w, w, s.when)) continue   // spec không áp cho bản ghi tổng này
    applied++
    const summed = (s.sign ?? 1) * parts.filter((p) => matchWhere(p, w, s.where)).reduce((acc, p) => acc + Number(p.data[s.sum] ?? 0), 0)
    const declared = Number(w.data[s.whole] ?? 0)
    if (Math.abs(declared - summed) > tol) misses.push({ rel: r.name, from: r.from, wholeId: w.id, whole: s.whole, sum: s.sum, declared, summed, diff: declared - summed })
  }
  return { misses, applied }
}

/** Danh sách LỆCH THẬT, kèm bản ghi và số tiền — `scoreOntologyData` chỉ trả tỉ lệ, không đủ để NÊU cho người soát.
 *  Không có khai báo `reconcile`/`whole+parts` ⇒ quan hệ đó không so được, bỏ qua (khai thiếu là việc của ontology,
 *  không phải phát hiện về hồ sơ khách). */
export function reconcileMismatches(o: OntologyForSoundness, data: OntologyData, tol = 1): { misses: ReconcileMiss[]; skipped: ReconcileSkipped[] } {
  const misses: ReconcileMiss[] = []
  const skipped: ReconcileSkipped[] = []
  for (const r of o.relationships) {
    if (r.kind !== 'derivation' || !specsOf(r).length) continue
    for (const w of data.instances(r.from)) {
      const parts = data.neighbors(w.id, r.name)
      if (!parts.length) continue          // chưa nối được ⇒ luật ĐỨT ĐƯỜNG lo, không kết luận lệch ở đây
      const res = missesOf(r, w, parts, tol)
      if (!res.applied) { skipped.push({ rel: r.name, from: r.from, wholeId: w.id }); continue }
      misses.push(...res.misses)
    }
  }
  return { misses, skipped }
}

export function scoreOntologyData(o: OntologyForSoundness, data: OntologyData, tol = 1): RelScore[] {
  return o.relationships.map((r): RelScore => {
    const wholes = data.instances(r.from)
    if (r.kind === 'derivation') {
      let checked = 0, ok = 0
      for (const w of wholes) {
        const parts = data.neighbors(w.id, r.name); if (!parts.length) continue
        checked++
        const res = missesOf(r, w, parts, tol)
        if (res.applied && !res.misses.length) ok++   // không spec nào áp ⇒ CHƯA kiểm, không tính là đạt
      }
      return { name: r.name, kind: r.kind, checked, ok, score: checked ? ok / checked : null }
    }
    if (r.kind === 'composition') {
      const covered = wholes.filter((w) => data.neighbors(w.id, r.name).length > 0).length
      return { name: r.name, kind: r.kind, checked: wholes.length, ok: covered, score: wholes.length ? covered / wholes.length : null }
    }
    if (r.kind === 'correspondence' && r.match) {
      let checked = 0, ok = 0
      for (const w of wholes) {
        const ns = data.neighbors(w.id, r.name); if (!ns.length) continue
        checked++
        const right = ns.reduce((s, n) => s + Number(n.data[r.match!.right] ?? 0), 0)
        if (Math.abs(Number(w.data[r.match!.left] ?? 0) - right) <= tol) ok++
      }
      return { name: r.name, kind: r.kind, checked, ok, score: checked ? ok / checked : null }
    }
    return { name: r.name, kind: r.kind ?? 'reference', checked: 0, ok: 0, score: null }
  })
}

// ── (c) AUTO-GENERATE definitional reconciliation rules from the ontology ────────
const rel = (name: string): ExprNode => ({ op: 'rel', rel: name })
const prop = (field: string): ExprNode => ({ op: 'prop', field })
const selfProp = (field: string): ExprNode => ({ op: 'prop', field, node: { op: 'self' } })
const lit = (value: string | number): ExprNode => ({ op: 'lit', value })
const exists = (set: ExprNode): ExprNode => ({ op: 'exists', set })
const sumOf = (set: ExprNode, value: ExprNode): ExprNode => ({ op: 'sum', set, value })
const sumIf = (set: ExprNode, where: ExprNode, value: ExprNode): ExprNode => ({ op: 'sumif', set, where, value })
const eq = (left: ExprNode, right: ExprNode): ExprNode => ({ op: 'compare', cmp: '=', left, right })
const ne = (left: ExprNode, right: ExprNode, tolerance: number): ExprNode => ({ op: 'compare', cmp: '!=', left, right, tolerance })
const and = (...children: ExprNode[]): ExprNode => ({ op: 'and', children })
const or = (...children: ExprNode[]): ExprNode => ({ op: 'or', children })

const crit = (value: string | number): ExprNode =>
  typeof value === 'string' && value.startsWith('$') ? selfProp(value.slice(1)) : lit(value)

/** Build a SUMIF criteria condition (over the iterated part `it`). Multiple fields = AND;
 *  array value = OR (in-set). `$x` value = the whole's property x. */
function whereExpr(where: ReconcileSpec['where']): ExprNode | null {
  const conds = Object.entries(where ?? {}).map(([field, c]) =>
    Array.isArray(c) ? or(...c.map((v) => eq(prop(field), crit(v)))) : eq(prop(field), crit(c)))
  return conds.length === 0 ? null : conds.length === 1 ? conds[0] : and(...conds)
}

/** The reconciliation IR for one spec: whole = SUMIF(parts.sum WHERE …). */
function reconcileExpr(relName: string, spec: ReconcileSpec, tol: number): ExprNode {
  const w = whereExpr(spec.where)
  const summed = w ? sumIf(rel(relName), w, prop(spec.sum)) : sumOf(rel(relName), prop(spec.sum))
  return and(exists(rel(relName)), ne(selfProp(spec.whole), summed, tol))
}

/** Emit the reconciliation RuleSpecs implied by the ontology's declarations:
 *  derivation → whole = SUMIF(parts) per `reconcile` spec (or the simple whole/parts);
 *  correspondence → left = Σ matched right. DEFINITIONAL — born with the ontology, not hand-written.
 *
 *  `tolerance` is how far apart two sums may be and still agree. The default of 1 absorbs rounding
 *  in whole currency units; an app counting kilograms, ratios or people passes its own. */
export function reconciliationRules(o: OntologyForSoundness, opts: { tolerance?: number } = {}): RuleSpec[] {
  const tol = opts.tolerance ?? 1
  const out: RuleSpec[] = []
  for (const r of o.relationships) {
    const specs: ReconcileSpec[] | undefined =
      r.reconcile ?? (r.kind === 'derivation' && r.fold === 'sum' && r.whole && r.parts ? [{ whole: r.whole, sum: r.parts }] : undefined)
    if (r.kind === 'derivation' && specs) {
      for (const spec of specs)
        out.push(rule({
          on: r.from, id: `R-RECON-${r.name}-${spec.whole}`, severity: 'critical',
          khi: (self, io) => evalBool(reconcileExpr(r.name, spec, tol), { self, io } as EvalCtx),
        }))
    } else if (r.kind === 'correspondence' && r.match) {
      out.push(rule({
        on: r.from, id: `R-MATCH-${r.name}`, severity: 'critical',
        khi: (self, io) => evalBool(and(exists(rel(r.name)), ne(selfProp(r.match!.left), sumOf(rel(r.name), prop(r.match!.right)), tol)), { self, io } as EvalCtx),
      }))
    }
  }
  return out
}
