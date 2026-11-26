// CORE OPERATIONS — the closed primitive basis every rule composes from.
//
// THEORY (why this set, and why it never needs extending):
//   A data-quality rule is a predicate over a finite relational structure
//   (the kinetic ontology: nodes with scalar properties + named directed edges).
//   The class of rules we admit is GUARDED FIRST-ORDER LOGIC + AGGREGATION —
//   the largest class that is still decidable, terminating and deterministic
//   (a check MUST always halt with yes/no). By Codd's theorem (extended with the
//   aggregation operator γ, the formal model of SQL), this class is captured by a
//   FINITE relational algebra: selection σ, projection π, aggregation γ, the join
//   along declared edges, arithmetic function symbols, boolean ∧∨¬, quantifiers ∃∀.
//   The ops below ARE that algebra, re-skinned. The type universe
//       U = { Num, Text, Bool, Node, NodeSet }
//   is CLOSED under every op (each op's result ∈ U), so no composition ever
//   escapes it ⇒ no new primitive is ever forced WITHIN the class. The only way
//   out is to climb a known, strict expressiveness hierarchy
//       guarded-FO+agg ⊊ FO+TC ⊊ FO+LFP ⊊ …
//   which adds a FINITE, named set of escape primitives (see BOUNDARY below):
//   transitive closure (`reach`) and ordered/temporal/text functions
//   (`daysBetween`, `startsWith`). That set is enumerable up front, not discovered
//   per-rule — which is why `needs-primitive` converges to zero.
//
//   Cross-referenced to Excel functions, since Excel is the canonical example of a
//   finite library of pure, composable functions a non-programmer reuses.
//
//   Node    = Instance        (a thing of an entity type)
//   NodeSet = Instance[]       (the extension of a relationship, or a found set)
//   Scalar  = number | string | boolean
//
// Everything async-tolerant: predicates/projections may touch `io` (graph reads),
// so they may return a Promise; the ops await internally.

import type { Instance, FunctionIO } from '@dqa-ai-solutions/ontology-sdk'

export type Node = Instance
export type NodeSet = Instance[]
export type Scalar = number | string | boolean

/** Predicate over a node — may read the graph, hence possibly async. */
export type Pred = (n: Node) => boolean | Promise<boolean>
/** Projection of a node to a number — a field name (sugar) or a function. */
export type Proj = string | ((n: Node) => number | Promise<number>)

const project = (field: Proj): ((n: Node) => number | Promise<number>) =>
  typeof field === 'string' ? (n: Node) => Number(n.data[field] ?? 0) : field

// ── ACCESS — read a value off the structure ─────────────────────────────────────
//    relational: projection π / the extension of an edge. Excel: a cell reference.

/** Numeric property; missing ⇒ 0. (Excel: a numeric cell reference.) */
export const num = (n: Node, field: string): number => Number(n.data[field] ?? 0)

/** Text property; missing ⇒ ''. (Excel: a text cell reference.) */
export const text = (n: Node, field: string): string => String(n.data[field] ?? '')

/** Boolean property. */
export const bool = (n: Node, field: string): boolean => Boolean(n.data[field])

/** Navigate a declared relationship to its neighbour nodes — the guarded join.
 *  (No Excel analog: this is graph navigation, the one thing a spreadsheet lacks.) */
export const rel = (io: FunctionIO, n: Node, relName: string): Promise<NodeSet> =>
  io.neighbors(n.id, relName)

/** Find all nodes of a type (optionally the whole set to then `filter`). */
export const all_of = (io: FunctionIO, entityType: string): Promise<NodeSet> =>
  io.find(entityType)

// ── SET → SET — selection / projection ─────────────────────────────────────────

/** Select the subset matching a predicate. (Excel: FILTER, or the criteria of *IF.) */
export async function filter(set: NodeSet, pred: Pred): Promise<NodeSet> {
  const keep: Node[] = []
  for (const n of set) if (await pred(n)) keep.push(n)
  return keep
}

// ── SET → SCALAR — aggregation (fold) ──────────────────────────────────────────

/** Σ of a projected field over a set. (Excel: SUM / SUMIF / SUMPRODUCT.) */
export async function sum(set: NodeSet, field: Proj): Promise<number> {
  const f = project(field)
  let s = 0
  for (const n of set) s += await f(n)
  return s
}

/** Count nodes, optionally those matching a predicate. (Excel: COUNT / COUNTIF.) */
export async function count(set: NodeSet, pred?: Pred): Promise<number> {
  return pred ? (await filter(set, pred)).length : set.length
}

/** Min of a projected field; empty set ⇒ undefined. (Excel: MIN / MINIFS.) */
export async function min(set: NodeSet, field: Proj): Promise<number | undefined> {
  const f = project(field)
  let m: number | undefined
  for (const n of set) {
    const v = await f(n)
    if (m === undefined || v < m) m = v
  }
  return m
}

/** Max of a projected field; empty set ⇒ undefined. (Excel: MAX / MAXIFS.) */
export async function max(set: NodeSet, field: Proj): Promise<number | undefined> {
  const f = project(field)
  let m: number | undefined
  for (const n of set) {
    const v = await f(n)
    if (m === undefined || v > m) m = v
  }
  return m
}

/** Average — derived (Σ/count); empty set ⇒ undefined. (Excel: AVERAGE / AVERAGEIF.) */
export async function avg(set: NodeSet, field: Proj): Promise<number | undefined> {
  if (set.length === 0) return undefined
  return (await sum(set, field)) / set.length
}

// ── ARITHMETIC — + − × ÷ are language-native; only `abs` needs a name ───────────
//    (Excel: +, -, *, /, ABS.)
export const abs = (x: number): number => Math.abs(x)

// ── COMPARE — scalar → bool (Excel: =, <>, <, <=, >, >=) ────────────────────────

/** Equality within a tolerance — the accounting workhorse (rounding in đồng).
 *  tol = 0 ⇒ exact. (Excel: ABS(a-b) <= tol.) */
export const eq = (a: number, b: number, tol = 0): boolean => Math.abs(a - b) <= tol
export const ne = (a: number, b: number, tol = 0): boolean => Math.abs(a - b) > tol
export const lt = (a: number, b: number): boolean => a < b
export const le = (a: number, b: number): boolean => a <= b
export const gt = (a: number, b: number): boolean => a > b
export const ge = (a: number, b: number): boolean => a >= b
/** Text equality. */
export const eqText = (a: string, b: string): boolean => a === b

// ── LOGIC — bool → bool (Excel: AND / OR / NOT) ─────────────────────────────────
export const and = (...xs: boolean[]): boolean => xs.every(Boolean)
export const or = (...xs: boolean[]): boolean => xs.some(Boolean)
export const not = (x: boolean): boolean => !x

// ── QUANTIFY — set → bool (Excel: OR-over-range / AND-over-range) ────────────────

/** ∃ — some node satisfies the predicate. (Excel: OR over a range.) */
export async function any(set: NodeSet, pred: Pred): Promise<boolean> {
  for (const n of set) if (await pred(n)) return true
  return false
}

/** ∀ — every node satisfies the predicate. (Excel: AND over a range.) */
export async function all(set: NodeSet, pred: Pred): Promise<boolean> {
  for (const n of set) if (!(await pred(n))) return false
  return true
}

/** Non-empty / empty — existence as a boolean. (Excel: COUNTA > 0.) */
export const exists = (set: NodeSet): boolean => set.length > 0
export const isEmpty = (set: NodeSet): boolean => set.length === 0

// ── CONDITIONAL / LOOKUP — value selection (Excel: IF / VLOOKUP) ─────────────────

/** Branch a value. (Excel: IF.) Derivable, but ubiquitous (e.g. normalBalance branch). */
export const ifElse = <T>(cond: boolean, a: T, b: T): T => (cond ? a : b)

/** First node whose field equals a value, else null. (Excel: VLOOKUP / INDEX-MATCH.) */
export async function lookup(set: NodeSet, field: string, value: Scalar): Promise<Node | null> {
  for (const n of set) if (n.data[field] === value) return n
  return null
}

// ── BOUNDARY PRIMITIVES — the finite, KNOWN escapes beyond guarded-FO+agg ────────
//    These lift the basis exactly one rung up the expressiveness hierarchy. The set
//    is enumerable up front (a survey of the domain), NOT discovered per rule.

/** Transitive closure: every node reachable via repeated `relName` traversal
 *  (the FO+TC rung — e.g. rolling up an account hierarchy of arbitrary depth).
 *  Bounded BFS with a visited set ⇒ always terminates. (No Excel analog.) */
export async function reach(
  io: FunctionIO,
  n: Node,
  relName: string,
  maxDepth = 64,
): Promise<NodeSet> {
  const seen = new Set<string>([n.id])
  const out: Node[] = []
  let frontier: Node[] = [n]
  for (let d = 0; d < maxDepth && frontier.length > 0; d++) {
    const next: Node[] = []
    for (const f of frontier) {
      for (const m of await io.neighbors(f.id, relName)) {
        if (seen.has(m.id)) continue
        seen.add(m.id)
        out.push(m)
        next.push(m)
      }
    }
    frontier = next
  }
  return out
}

/** Whole days from ISO date `a` to ISO date `b` (b − a). Negative if b precedes a.
 *  Deterministic (parses explicit strings — no clock read). (Excel: DATEDIF / b−a.) */
export const daysBetween = (a: string, b: string): number =>
  Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)

/** Số tiền theo lối viết Việt Nam (1.234.567) — CÙNG bộ định dạng mà chỗ chèn `{x|vnd}` dùng.
 *  Cần vì `|vnd` chỉ áp ở CHỖ CHÈN: một câu ghép bằng `concat` sẽ in ra số thô (12821910284đ) và lọt
 *  thẳng vào bản soát xét gửi doanh nghiệp. Một chỗ định dạng duy nhất, không hai lối viết. */
export const money = (v: unknown): string => Math.round(Number(v ?? 0)).toLocaleString('vi-VN')

/** Concatenate parts into one string — missing parts render as ''. Without it a rule can name a
 *  column but not DECORATE it ("TK 2118 (ai tham chiếu)"), so any sentence composed of more than one
 *  field still had to be hand-written code. (Excel: CONCAT / &.) */
export const concatText = (parts: unknown[]): string =>
  parts.map((p) => (p === null || p === undefined ? '' : String(p))).join('')

/** Fold a set into TEXT — the missing half of aggregation.
 *  The algebra can already fold a set into a NUMBER (`sum`, `count`); it could not fold one into a
 *  string, so any rule whose sentence must NAME the offenders ("months 1, 2, 5 have no payroll")
 *  had to be hand-written code. Deterministic: values are de-duplicated and sorted, so the same set
 *  always renders the same sentence regardless of read order. (Excel: TEXTJOIN.) */
export const joinText = (xs: unknown[], sep: string): string =>
  [...new Set(xs.map((x) => (x === null || x === undefined ? '' : String(x))).filter((x) => x !== ''))]
    .sort((a, b) => (Number(a) && Number(b) ? Number(a) - Number(b) : a.localeCompare(b)))
    .join(sep)

/** Total coercion to a number — missing / blank / non-numeric ⇒ 0.
 *  WHY THIS IS A CORE OP: real client data is sparse. Without it, `x > 0` on a field that
 *  some instances lack THROWS, the whole rule is dropped for that period, and the check goes
 *  silent — the worst outcome. Hand-written rules have always coerced (`num(d.x)`); this makes
 *  the same totality available to a declared rule, which is the only way a declared rule can
 *  replace a coded one. It does hide garbage as 0 — the same trade the coded path already makes. */
export const toNum = (v: unknown): number => {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').replace(/[,\s]/g, ''))
  return Number.isFinite(n) ? n : 0
}

/** Total coercion to text — missing ⇒ ''. Makes `text(x) != ''` mean "present and non-blank",
 *  where a bare `prop != ''` on a MISSING field evaluates to true and fires on everything. */
export const toText = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

/** Total length — array or string, missing ⇒ 0. Lets a rule ask "has no roles" without
 *  `empty`, which requires a real node set and throws on a plain array-valued property. */
export const sizeOf = (v: unknown): number =>
  Array.isArray(v) ? v.length : v === null || v === undefined ? 0 : String(v).length

/** Text prefix test — e.g. account code starts with '511'. (Excel: LEFT(x,n) = p.) */
export const startsWith = (s: string, prefix: string): boolean => s.startsWith(prefix)

/** Case-insensitive substring test — e.g. an asset description mentioning 'sáng chế'.
 *  Sibling of {@link startsWith}: without it, every "does this text mention X" rule has
 *  to be hand-written code, which is exactly what the IR exists to avoid. Decidable and
 *  total (non-string ⇒ coerced, missing ⇒ ''). (Excel: ISNUMBER(SEARCH(v,s)).) */
export const textContains = (s: string, value: string): boolean =>
  String(s ?? '').toLowerCase().includes(String(value ?? '').toLowerCase())

/** Leading `n` characters — e.g. the 3-digit group of an account code. Pairs with
 *  {@link startsWith} to let a rule compare two codes AT A GIVEN DEPTH, which prefix
 *  matching alone cannot express ('1121' vs '1122' share a group but neither prefixes
 *  the other). Negative/zero `n` ⇒ ''. (Excel: LEFT.) */
export const left = (s: string, n: number): string =>
  n > 0 ? String(s ?? '').slice(0, Math.floor(n)) : ''

/** Membership in an array-valued property — e.g. a semantic role ∈ node.roles.
 *  A bounded ∃ over a finite list (still within the decidable class), so it is a
 *  core op, not an escape. Non-array / missing ⇒ false. (Excel: COUNTIF(range,v) > 0.) */
export const contains = (n: Node, field: string, value: Scalar): boolean => {
  const arr = n.data[field]
  return Array.isArray(arr) && arr.includes(value)
}
