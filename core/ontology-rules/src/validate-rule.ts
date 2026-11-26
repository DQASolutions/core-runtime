// VALIDATE-RULE — the deterministic completeness checker for a rule-as-DATA draft.
//
//   NL → AI parse → PartialRuleSpec (ExprNode, may have holes) →
//   validateRuleSpec(partial, registry) → UnresolvedSlot[] →
//   UI fills each slot from its CLOSED option set (enumerated from the ontology) →
//   re-validate … until [] → back-test → expert gate → active.
//
// AI is involved ONLY in the first parse. Everything here is a pure function of
// (PartialRuleSpec, DomainRegistry) — no judgment, no AI. A draft is COMPLETE when
// validateRuleSpec returns []. Every reported slot carries the exact closed set of
// valid choices, so the UI never asks an open question.
//
// It validates the SAME `ExprNode` the interpreter (eval-expr.ts) runs — one
// canonical IR, checked and executed by one definition. Scope tracking: a `prop`
// is checked against the entity type actually in scope at that point in the tree,
// which changes as you traverse relationships (so "Σ subledger.closingBalance"
// checks `closingBalance` on the SubledgerEntry type, not on the root type).

import type { ExprNode } from './eval-expr.js'

/** One slot that failed a completeness check — the UI fills it from `options`. */
export interface UnresolvedSlot {
  /** Which check fired, e.g. 'M-PROP-REF'. */
  metaRuleId: string
  /** Dotted path to the slot, e.g. 'expr.left.set'. */
  slot: string
  /** Human-readable reason. */
  message: string
  /** Valid choices — a CLOSED set enumerated from the domain ontology. */
  options: string[]
  /** Set when the slot needs something outside the current basis. */
  escalate?: 'needs-primitive' | 'decompose'
}

/** A draft rule as data. `expr` is the violation condition (true ⇒ rule fires).
 *  The focus entity type may be given as `appliesTo` (draft/UI naming) or `on`
 *  (the stored RuleIR naming) — they are aliases. */
export interface PartialRuleSpec {
  ruleId?: string
  appliesTo?: string
  on?: string
  severity?: string
  /** May be null (no condition yet) or contain holes (empty ref fields). */
  expr?: ExprNode | null
}

/** What exists in the domain — injected so validation stays a pure function. */
export interface DomainRegistry {
  hasEntityType(type: string): boolean
  entityTypes(): string[]
  /** Property names on an entity type. */
  propertiesOf(type: string): string[]
  /** Relationship names usable FROM an entity type (either direction). */
  relationshipsOf(type: string): string[]
  /** The entity type reached by traversing `rel` from `type`, or undefined. */
  relationshipTarget(type: string, rel: string): string | undefined
  hasCompute(name: string): boolean
  computes(): string[]
  /** Known LawParameter keys (closed set for `param` ops). */
  hasParam(key: string): boolean
  paramKeys(): string[]
  hasRuleId(id: string): boolean
}

const SEVERITIES = ['critical', 'warning', 'info']

// A raw (possibly-incomplete) expression: tolerate missing op / empty ref strings.
type Raw = { op?: string } & Record<string, unknown>
// root = appliesTo (`self`); cur = phần tử hiện hành (`it`); vars = phần tử ĐƯỢC ĐẶT TÊN (`as` → `var`).
// Không mang `vars` theo thì bộ kiểm không biết kiểu của biến vòng ngoài và báo nhầm "trường không tồn
// tại" cho luật ĐÚNG — bộ kiểm sai còn tai hại hơn không có bộ kiểm, vì nó chặn việc đúng.
interface Scope { root: string; cur: string; vars?: Record<string, string> }

/** Run all completeness checks. Returns [] when the draft is ready for review. */
export function validateRuleSpec(spec: PartialRuleSpec, reg: DomainRegistry): UnresolvedSlot[] {
  const slots: UnresolvedSlot[] = []

  // ── structural meta-rules ──
  if (!spec.severity || !SEVERITIES.includes(spec.severity))
    slots.push({ metaRuleId: 'M-SEVERITY', slot: 'severity', message: 'severity must be set', options: SEVERITIES })

  if (spec.ruleId && reg.hasRuleId(spec.ruleId))
    slots.push({ metaRuleId: 'M-RULE-ID-UNIQUE', slot: 'ruleId', message: `Rule ID "${spec.ruleId}" already exists`, options: [] })

  const appliesTo = spec.appliesTo ?? spec.on
  const appliesOk = !!appliesTo && reg.hasEntityType(appliesTo)
  if (!appliesOk)
    slots.push({ metaRuleId: 'M-APPLIES-TO', slot: 'appliesTo', message: `Entity type "${appliesTo ?? ''}" not in the ontology`, options: reg.entityTypes() })

  if (spec.expr == null)
    slots.push({ metaRuleId: 'M-HAS-CONDITION', slot: 'expr', message: 'Rule has no condition expression', options: ['compare', 'and', 'or', 'not', 'any', 'exists', 'if'] })

  // ── reference resolution — only when the focus type is known (gives the root scope) ──
  if (appliesOk && spec.expr != null)
    walk(spec.expr as Raw, { root: appliesTo!, cur: appliesTo! }, 'expr', reg, slots)

  // KHỐI `finding` cũng phải soi. Trước đây bỏ qua hoàn toàn — một tên trường sai trong `delta` hay
  // trong `values` không ai bắt, và hậu quả là luật NỔ ĐÚNG nhưng câu nó nói ra rỗng số. Đó đúng lớp
  // lỗi "luật không nói được nó thấy gì": tệ hơn luật không chạy, vì nó trông như đã chạy xong.
  const finding = (spec as { finding?: { label?: unknown; delta?: unknown; values?: Record<string, unknown> } }).finding
  if (appliesOk && finding) {
    const scope = { root: appliesTo!, cur: appliesTo! }
    if ((finding as { severity?: unknown }).severity !== undefined) walk((finding as { severity?: Raw }).severity as Raw, scope, 'finding.severity', reg, slots)
    if (finding.label !== undefined) walk(finding.label as Raw, scope, 'finding.label', reg, slots)
    if (finding.delta !== undefined) walk(finding.delta as Raw, scope, 'finding.delta', reg, slots)
    for (const [k, e] of Object.entries(finding.values ?? {})) walk(e as Raw, scope, `finding.values.${k}`, reg, slots)
  }

  return slots

  // ── recursive walk with scope + path ──
  function walk(node: Raw, scope: Scope, path: string, reg: DomainRegistry, out: UnresolvedSlot[]): void {
    const op = node?.op
    if (!op) {
      out.push({ metaRuleId: 'M-HAS-OP', slot: path, message: 'Expression node has no op', options: ['compare', 'and', 'or', 'not', 'prop', 'rel', 'sum', 'count', 'any', 'if', 'lit'] })
      return
    }
    switch (op) {
      case 'lit':
      case 'self':
      case 'it':
      // `var` trỏ tới phần tử của một phép duyệt BAO NGOÀI. Kiểu của nó chỉ biết được nếu bộ kiểm mang
      // theo bảng biến; hiện chưa mang, nên không suy kiểu qua đây (không khẳng định sai còn hơn khẳng
      // định bừa). `as` chưa ràng buộc thì evaluator ném rõ ràng lúc chạy.
      case 'var':
        return

      case 'prop':
      case 'contains': {
        const tType = nodeType(node.node as Raw | undefined, scope) ?? scope.cur
        const field = String(node.field ?? '')
        if (!reg.propertiesOf(tType).includes(field))
          out.push({ metaRuleId: 'M-PROP-REF', slot: `${path}.field`, message: `Property "${field}" does not exist on ${tType}`, options: reg.propertiesOf(tType) })
        return
      }

      case 'rel': {
        const fromT = nodeType(node.node as Raw | undefined, scope) ?? scope.cur
        if (!reg.relationshipTarget(fromT, String(node.rel ?? '')))
          out.push({ metaRuleId: 'M-REL-REF', slot: `${path}.rel`, message: `Relationship "${String(node.rel ?? '')}" does not exist on ${fromT}`, options: reg.relationshipsOf(fromT) })
        return
      }

      case 'find': {
        const t = String(node.entityType ?? '')
        if (!reg.hasEntityType(t))
          out.push({ metaRuleId: 'M-APPLIES-TO', slot: `${path}.entityType`, message: `Entity type "${t}" not in the ontology`, options: reg.entityTypes() })
        return
      }

      case 'filter':
      case 'any':
      case 'all': {
        walk(node.set as Raw, scope, `${path}.set`, reg, out)
        const elemT = setType(node.set as Raw, scope, reg) ?? scope.cur
        walk(node.where as Raw, elemScope(scope, elemT, node.as), `${path}.where`, reg, out)
        return
      }

      case 'sum':
      case 'min':
      case 'max':
      case 'avg': {
        walk(node.set as Raw, scope, `${path}.set`, reg, out)
        const elemT = setType(node.set as Raw, scope, reg) ?? scope.cur
        walk(node.value as Raw, elemScope(scope, elemT, node.as), `${path}.value`, reg, out)
        return
      }

      case 'count': {
        walk(node.set as Raw, scope, `${path}.set`, reg, out)
        if (node.where) {
          const elemT = setType(node.set as Raw, scope, reg) ?? scope.cur
          walk(node.where as Raw, elemScope(scope, elemT, node.as), `${path}.where`, reg, out)
        }
        return
      }

      case 'exists':
      case 'empty':
        walk(node.set as Raw, scope, `${path}.set`, reg, out)
        return

      case 'add':
      case 'sub':
      case 'mul':
      case 'div':
      case 'compare':
        walk(node.left as Raw, scope, `${path}.left`, reg, out)
        walk(node.right as Raw, scope, `${path}.right`, reg, out)
        return

      case 'abs':
        walk(node.arg as Raw, scope, `${path}.arg`, reg, out)
        return

      case 'not':
        walk(node.child as Raw, scope, `${path}.child`, reg, out)
        return

      case 'and':
      case 'or':
        (node.children as Raw[] | undefined ?? []).forEach((c, i) => walk(c, scope, `${path}.children[${i}]`, reg, out))
        return

      case 'if':
        walk(node.cond as Raw, scope, `${path}.cond`, reg, out)
        walk(node.then as Raw, scope, `${path}.then`, reg, out)
        walk(node.else as Raw, scope, `${path}.else`, reg, out)
        return

      case 'reach': {
        const fromT = nodeType(node.node as Raw | undefined, scope) ?? scope.cur
        if (!reg.relationshipTarget(fromT, String(node.rel ?? '')))
          out.push({ metaRuleId: 'M-REL-REF', slot: `${path}.rel`, message: `Relationship "${String(node.rel ?? '')}" does not exist on ${fromT}`, options: reg.relationshipsOf(fromT) })
        return
      }

      case 'incoming': {
        // Chiều NGƯỢC: quan hệ phải tồn tại với ĐÍCH là kiểu hiện hành, không phải nguồn.
        if (!reg.entityTypes().some((t) => reg.relationshipTarget(t, String(node.rel ?? ''))))
          out.push({ metaRuleId: 'M-REL-REF', slot: `${path}.rel`, message: `Relationship "${String(node.rel ?? '')}" does not exist`, options: [] })
        return
      }

      case 'daysBetween':
        walk(node.from as Raw, scope, `${path}.from`, reg, out)
        walk(node.to as Raw, scope, `${path}.to`, reg, out)
        return

      case 'startsWith':
        walk(node.text as Raw, scope, `${path}.text`, reg, out)
        walk(node.prefix as Raw, scope, `${path}.prefix`, reg, out)
        return

      case 'textContains':
        walk(node.text as Raw, scope, `${path}.text`, reg, out)
        walk(node.value as Raw, scope, `${path}.value`, reg, out)
        return

      case 'left':
        walk(node.text as Raw, scope, `${path}.text`, reg, out)
        walk(node.n as Raw, scope, `${path}.n`, reg, out)
        return

      // ÉP KIỂU TOÀN PHẦN — trong suốt với bộ kiểm: chỉ đi tiếp vào đối số.
      case 'concat':
        for (const [i, e] of ((node.parts as Raw[]) ?? []).entries()) walk(e, scope, `${path}.parts[${i}]`, reg, out)
        return

      case 'join':
        walk(node.set as Raw, scope, `${path}.set`, reg, out)
        // `setType` (không phải `nodeType`) — nó xuyên qua `filter`/`rel` để ra KIỂU PHẦN TỬ. Dùng nhầm
        // `nodeType` thì scope đứng nguyên ở entity gốc và mọi trường của phần tử bị báo "không tồn tại".
        walk(node.value as Raw, elemScope(scope, setType(node.set as Raw, scope, reg) ?? scope.cur, node.as), `${path}.value`, reg, out)
        return

      case 'num':
      case 'text':
      case 'size':
      case 'money':
        walk(node.arg as Raw, scope, `${path}.arg`, reg, out)
        return

      case 'sumNeighbors': {
        const target = reg.relationshipTarget(scope.cur, String(node.rel ?? ''))
        if (!target) {
          out.push({ metaRuleId: 'M-REL-REF', slot: `${path}.rel`, message: `Relationship "${String(node.rel ?? '')}" does not exist on ${scope.cur}`, options: reg.relationshipsOf(scope.cur) })
        } else if (!reg.propertiesOf(target).includes(String(node.field ?? ''))) {
          out.push({ metaRuleId: 'M-PROP-REF', slot: `${path}.field`, message: `Property "${String(node.field ?? '')}" does not exist on ${target}`, options: reg.propertiesOf(target) })
        }
        return
      }

      case 'countNeighbors':
      case 'hasNeighbors': {
        if (!reg.relationshipTarget(scope.cur, String(node.rel ?? '')))
          out.push({ metaRuleId: 'M-REL-REF', slot: `${path}.rel`, message: `Relationship "${String(node.rel ?? '')}" does not exist on ${scope.cur}`, options: reg.relationshipsOf(scope.cur) })
        return
      }

      case 'call': {
        const name = String(node.name ?? '')
        if (!reg.hasCompute(name))
          out.push({ metaRuleId: 'M-CALL-REF', slot: `${path}.name`, message: `Compute "${name}" is not in the function library`, options: reg.computes(), escalate: 'needs-primitive' })
        return
      }

      case 'param': {
        const key = String(node.key ?? '')
        if (!reg.hasParam(key))
          out.push({ metaRuleId: 'M-PARAM-REF', slot: `${path}.key`, message: `Law parameter "${key}" is not declared`, options: reg.paramKeys() })
        return
      }

      default:
        out.push({ metaRuleId: 'M-UNKNOWN-OP', slot: `${path}.op`, message: `Unknown op "${op}"`, options: [] })
    }
  }

  // entity type a node-valued ref points at (only self/it are node refs)
  function nodeType(node: Raw | undefined, scope: Scope): string | undefined {
    if (!node) return undefined
    if (node.op === 'self') return scope.root
    if (node.op === 'it') return scope.cur
    if (node.op === 'var') return scope.vars?.[String(node.name ?? '')]
    return undefined
  }

  /** Ngữ cảnh BÊN TRONG một phép duyệt tập: `it` thành kiểu phần tử, và nếu khai `as` thì ràng thêm tên. */
  function elemScope(scope: Scope, elemT: string, as?: unknown): Scope {
    const name = typeof as === 'string' && as ? as : undefined
    return { root: scope.root, cur: elemT, vars: name ? { ...scope.vars, [name]: elemT } : scope.vars }
  }

  // element entity type of a set-valued node
  function setType(node: Raw | undefined, scope: Scope, reg: DomainRegistry): string | undefined {
    if (!node) return undefined
    switch (node.op) {
      case 'rel':
      case 'reach': {
        const fromT = nodeType(node.node as Raw | undefined, scope) ?? scope.cur
        return reg.relationshipTarget(fromT, String(node.rel ?? ''))
      }
      case 'find':
        return reg.hasEntityType(String(node.entityType ?? '')) ? String(node.entityType) : undefined
      case 'incoming': {
        // phần tử của tập ngược = kiểu NGUỒN của quan hệ (kiểu duy nhất có quan hệ này trỏ đi)
        const rel = String(node.rel ?? '')
        return reg.entityTypes().find((t) => reg.relationshipTarget(t, rel))
      }
      case 'filter':
        return setType(node.set as Raw, scope, reg)
      default:
        return undefined
    }
  }
}

// ── registry builder ─────────────────────────────────────────────────────────

/** Minimal ontology shape needed to build a registry (matches OntologyDecl). */
export interface RegistryOntology {
  entities?: { name: string; properties?: { name: string }[] }[]
  relationships?: { name: string; from: string; to: string }[]
}

/** Build a DomainRegistry from an ontology declaration + the known computes /
 *  existing rule ids. Relationships are usable from EITHER endpoint type (the
 *  graph is navigable both ways); the target is the opposite endpoint. */
export function buildRegistry(
  ontology: RegistryOntology,
  opts: { computes?: string[]; existingRuleIds?: string[]; paramKeys?: string[] } = {},
): DomainRegistry {
  const props = new Map<string, string[]>()
  for (const e of ontology.entities ?? []) props.set(e.name, (e.properties ?? []).map((p) => p.name))

  const rels = ontology.relationships ?? []
  const computeSet = new Set(opts.computes ?? [])
  const ruleIdSet = new Set(opts.existingRuleIds ?? [])
  const paramSet = new Set(opts.paramKeys ?? [])

  const relsFrom = (type: string) =>
    rels.filter((r) => r.from === type || r.to === type).map((r) => r.name)

  return {
    hasEntityType: (t) => props.has(t),
    entityTypes: () => [...props.keys()],
    propertiesOf: (t) => props.get(t) ?? [],
    relationshipsOf: relsFrom,
    relationshipTarget: (t, rel) => {
      const r = rels.find((x) => x.name === rel && (x.from === t || x.to === t))
      if (!r) return undefined
      return r.from === t ? r.to : r.from
    },
    hasCompute: (n) => computeSet.has(n),
    computes: () => [...computeSet],
    hasParam: (k) => paramSet.has(k),
    paramKeys: () => [...paramSet],
    hasRuleId: (id) => ruleIdSet.has(id),
  }
}
