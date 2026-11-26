// RULE SCHEMA — the FIXED, CONTROLLED contract for a rule-as-DATA (JSON) rule.
//
// WHY THIS EXISTS: the ExprNode TypeScript union is a compile-time type only — it
// gives NO guarantee about JSON loaded from disk at runtime. Without this gate, a
// malformed rule file would compile into a RuleSpec and only blow up MID-SWEEP.
// This module makes the schema a single, enumerable, VERSIONED source of truth and
// enforces it at LOAD time: unknown ops, unknown fields, missing required fields,
// or wrong field types are REJECTED before a rule can run.
//
// The op set is CLOSED (it is the formal enumeration of the closed primitive basis,
// see core-ops.ts). It does NOT grow dynamically: adding an op is a deliberate edit
// to OP_SCHEMA below + a RULE_SCHEMA_VERSION bump — a reviewed, controlled act, not
// implicit drift. `additionalProperties: false` everywhere means nothing outside the
// contract is ever silently accepted.

/** Bump ONLY when OP_SCHEMA or the RuleIR envelope changes.
 *  v2: added the optional `finding` template (label/delta/message).
 *  v3: added the `param` op (effective-dated law threshold resolved from LawParameter data).
 *  v4: added `sumif`/`countif` (Excel-style conditional aggregation).
 *  Additive & backward-compatible. */
export const RULE_SCHEMA_VERSION = 4

export const COMPARE_OPS = ['=', '!=', '<', '<=', '>', '>='] as const
export const SEVERITIES = ['critical', 'warning', 'info'] as const
export const STATUSES = ['draft', 'pending-review', 'active', 'deprecated'] as const

type FieldKind = 'expr' | 'exprList' | 'exprMap' | 'name' | 'scalar' | 'cmp' | 'number'
interface FieldSpec { kind: FieldKind; required: boolean }
type OpSpec = Record<string, FieldSpec>

const req = (kind: FieldKind): FieldSpec => ({ kind, required: true })
const opt = (kind: FieldKind): FieldSpec => ({ kind, required: false })

/** THE CLOSED OP SET. Each entry lists exactly the fields that op may carry.
 *  Keep in lockstep with eval-expr.ts (run) and core-ops.ts (basis). */
export const OP_SCHEMA: Readonly<Record<string, OpSpec>> = {
  // access
  lit:   { value: req('scalar') },
  self:  {},
  it:    {},
  prop:  { field: req('name'), node: opt('expr') },
  // navigation
  rel:   { rel: req('name'), node: opt('expr') },
  find:  { entityType: req('name') },
  // set → set
  filter: { set: req('expr'), where: req('expr') , as: opt('name') },
  // set → scalar
  sum:   { set: req('expr'), value: req('expr') , as: opt('name') },
  count: { set: req('expr'), where: opt('expr') , as: opt('name') },
  sumif: { set: req('expr'), where: req('expr'), value: req('expr') , as: opt('name') },   // Excel SUMIF
  countif: { set: req('expr'), where: req('expr') , as: opt('name') },                     // Excel COUNTIF
  min:   { set: req('expr'), value: req('expr') , as: opt('name') },
  max:   { set: req('expr'), value: req('expr') , as: opt('name') },
  avg:   { set: req('expr'), value: req('expr') , as: opt('name') },
  // arithmetic
  add:   { left: req('expr'), right: req('expr') },
  sub:   { left: req('expr'), right: req('expr') },
  mul:   { left: req('expr'), right: req('expr') },
  div:   { left: req('expr'), right: req('expr') },
  abs:   { arg: req('expr') },
  // compare
  compare: { cmp: req('cmp'), left: req('expr'), right: req('expr'), tolerance: opt('number') },
  // logic
  and:   { children: req('exprList') },
  or:    { children: req('exprList') },
  not:   { child: req('expr') },
  // quantify
  any:   { set: req('expr'), where: req('expr') , as: opt('name') },
  all:   { set: req('expr'), where: req('expr') , as: opt('name') },
  exists: { set: req('expr') },
  empty: { set: req('expr') },
  // conditional
  if:    { cond: req('expr'), then: req('expr'), else: req('expr') },
  // boundary primitives
  reach: { rel: req('name'), node: opt('expr') },
  incoming: { rel: req('name'), node: opt('expr') },
  daysBetween: { from: req('expr'), to: req('expr') },
  startsWith:  { text: req('expr'), prefix: req('expr') },
  textContains: { text: req('expr'), value: req('expr') },
  join:  { set: req('expr'), value: req('expr'), sep: opt('scalar') , as: opt('name') },
  // Tra phần tử của một phép duyệt BAO NGOÀI (ràng bằng `as`). `it` chỉ có MỘT ô nên vòng trong che
  // vòng ngoài — không có `var` thì khuôn "cộng chỉ tài khoản LÁ" không khai báo được.
  var:   { name: req('name') },
  concat: { parts: req('exprList') },
  num:   { arg: req('expr') },
  text:  { arg: req('expr') },
  money: { arg: req('expr') },
  size:  { arg: req('expr') },
  left:        { text: req('expr'), n: req('expr') },
  contains:    { field: req('name'), value: req('scalar'), node: opt('expr') },
  // sugar (back-compat) → desugar to rel + γ
  sumNeighbors:   { rel: req('name'), field: req('name') },
  countNeighbors: { rel: req('name') },
  hasNeighbors:   { rel: req('name') },
  // escape to a named Tầng-M compute
  call:  { name: req('name'), args: opt('exprMap') },
  // effective-dated law parameter (threshold-as-data)
  param: { key: req('name') },
}

// `nl` · `name` · `cite` · `citeReviewed` là SIÊU DỮ LIỆU QUẢN TRỊ, không tham gia phép tính — nhưng phải
// được cho phép, vì `cite` (căn cứ pháp lý) là thứ hạng nhất của sản phẩm này và app vẫn ghi nó vào tệp luật.
//
// ⚠️ Lược đồ này NGHIÊM NGẶT ở mức TỆP: một trường lạ làm `loadRuleStore` NÉM LỖI và rớt CẢ KHO luật, không
// phải chỉ luật ấy. Đo được: `cite`/`citeReviewed` trong `dinh-khoan.json` làm 19 test đối chiếu IR bị BỎ QUA
// (không phải đỏ — bị bỏ qua), tức mất luôn phép kiểm chứ không chỉ mất một luật.
const RULE_FIELDS = new Set(['id', 'on', 'severity', 'status', 'category', 'schemaVersion', 'expr', 'finding',
  'nl', 'name', 'cite', 'citeReviewed'])
const FINDING_FIELDS = new Set(['label', 'delta', 'values', 'severity', 'message'])

export interface SchemaError { path: string; message: string }

const isScalar = (v: unknown): boolean => ['string', 'number', 'boolean'].includes(typeof v)

function checkField(v: unknown, kind: FieldKind, path: string, out: SchemaError[]): void {
  switch (kind) {
    case 'expr': out.push(...validateExprSchema(v, path)); break
    case 'exprList':
      if (!Array.isArray(v)) { out.push({ path, message: 'expected a list of expressions' }); break }
      v.forEach((e, i) => out.push(...validateExprSchema(e, `${path}[${i}]`)))
      break
    case 'exprMap':
      if (v === null || typeof v !== 'object' || Array.isArray(v)) { out.push({ path, message: 'expected a name→expression map' }); break }
      for (const [k, e] of Object.entries(v as Record<string, unknown>)) out.push(...validateExprSchema(e, `${path}.${k}`))
      break
    case 'name':   if (typeof v !== 'string') out.push({ path, message: 'expected a string' }); break
    case 'scalar': if (!isScalar(v)) out.push({ path, message: 'expected a scalar (string | number | boolean)' }); break
    case 'cmp':    if (!COMPARE_OPS.includes(v as never)) out.push({ path, message: `expected one of ${COMPARE_OPS.join(' ')}` }); break
    case 'number': if (typeof v !== 'number') out.push({ path, message: 'expected a number' }); break
  }
}

/** Structural validation of one expression node against the FIXED op schema. */
export function validateExprSchema(node: unknown, path = 'expr'): SchemaError[] {
  const out: SchemaError[] = []
  if (node === null || typeof node !== 'object' || Array.isArray(node))
    return [{ path, message: 'expected an expression object' }]
  const obj = node as Record<string, unknown>
  const op = obj.op
  if (typeof op !== 'string') return [{ path: `${path}.op`, message: 'missing op' }]
  const spec = OP_SCHEMA[op]
  if (!spec) return [{ path: `${path}.op`, message: `unknown op "${op}" — not in the fixed rule schema (v${RULE_SCHEMA_VERSION})` }]

  const allowed = new Set(['op', ...Object.keys(spec)])
  for (const k of Object.keys(obj))
    if (!allowed.has(k)) out.push({ path: `${path}.${k}`, message: `unexpected field "${k}" for op "${op}"` })

  for (const [field, fs] of Object.entries(spec)) {
    const v = obj[field]
    if (v === undefined || v === null) { if (fs.required) out.push({ path: `${path}.${field}`, message: `missing required field "${field}"` }); continue }
    checkField(v, fs.kind, `${path}.${field}`, out)
  }
  return out
}

/** Structural validation of a whole rule-as-data envelope. */
export function validateRuleIRSchema(ir: unknown): SchemaError[] {
  if (ir === null || typeof ir !== 'object' || Array.isArray(ir)) return [{ path: '', message: 'rule must be an object' }]
  const r = ir as Record<string, unknown>
  const out: SchemaError[] = []
  for (const k of Object.keys(r)) if (!RULE_FIELDS.has(k)) out.push({ path: k, message: `unexpected field "${k}"` })
  if (typeof r.id !== 'string' || !r.id) out.push({ path: 'id', message: 'id (string) is required' })
  if (typeof r.on !== 'string' || !r.on) out.push({ path: 'on', message: 'on (entity type) is required' })
  if (r.severity !== undefined && !SEVERITIES.includes(r.severity as never)) out.push({ path: 'severity', message: `severity must be one of ${SEVERITIES.join(' ')}` })
  if (r.status !== undefined && !STATUSES.includes(r.status as never)) out.push({ path: 'status', message: `status must be one of ${STATUSES.join(' ')}` })
  if (r.category !== undefined && typeof r.category !== 'string') out.push({ path: 'category', message: 'category must be a string' })
  if (r.schemaVersion !== undefined && r.schemaVersion !== RULE_SCHEMA_VERSION) out.push({ path: 'schemaVersion', message: `unsupported schemaVersion ${String(r.schemaVersion)} (this kernel speaks v${RULE_SCHEMA_VERSION})` })
  if (r.expr === undefined || r.expr === null) out.push({ path: 'expr', message: 'expr (condition) is required' })
  else out.push(...validateExprSchema(r.expr, 'expr'))
  if (r.finding !== undefined) out.push(...validateFindingSchema(r.finding))
  return out
}

/** Structural validation of an optional finding template. */
function validateFindingSchema(f: unknown): SchemaError[] {
  if (f === null || typeof f !== 'object' || Array.isArray(f)) return [{ path: 'finding', message: 'finding must be an object' }]
  const obj = f as Record<string, unknown>
  const out: SchemaError[] = []
  for (const k of Object.keys(obj)) if (!FINDING_FIELDS.has(k)) out.push({ path: `finding.${k}`, message: `unexpected field "${k}"` })
  if (typeof obj.message !== 'string') out.push({ path: 'finding.message', message: 'message (string template) is required' })
  if (obj.label !== undefined) out.push(...validateExprSchema(obj.label, 'finding.label'))
  if (obj.delta !== undefined) out.push(...validateExprSchema(obj.delta, 'finding.delta'))
  if (obj.severity !== undefined) out.push(...validateExprSchema(obj.severity, 'finding.severity'))
  if (obj.values !== undefined) {
    if (obj.values === null || typeof obj.values !== 'object' || Array.isArray(obj.values)) {
      out.push({ path: 'finding.values', message: 'values must be an object of name → expression' })
    } else {
      for (const [k, e] of Object.entries(obj.values as Record<string, unknown>)) {
        // Tên phải khớp CHÍNH cú pháp chỗ chèn `{ten}`; khai một tên không chèn được là khai chết.
        if (!/^[A-Za-z0-9_]+$/.test(k)) out.push({ path: `finding.values.${k}`, message: 'tên chỉ được gồm chữ/số/gạch dưới (phải chèn được bằng {ten})' })
        out.push(...validateExprSchema(e, `finding.values.${k}`))
      }
    }
  }
  return out
}

export class RuleSchemaError extends Error {
  constructor(public errors: SchemaError[], context = '') {
    super(`Rule schema violation${context ? ` in ${context}` : ''}: ${errors.map((e) => `${e.path || '(root)'}: ${e.message}`).join('; ')}`)
    this.name = 'RuleSchemaError'
  }
}

/** Throw RuleSchemaError if `ir` does not conform to the fixed schema. */
export function assertRuleIRSchema(ir: unknown, context = ''): void {
  const errors = validateRuleIRSchema(ir)
  if (errors.length) throw new RuleSchemaError(errors, context)
}

// ── portable JSON Schema document (the published, machine-readable contract) ──

const kindToJsonSchema = (kind: FieldKind): Record<string, unknown> => {
  switch (kind) {
    case 'expr':     return { $ref: '#/$defs/expr' }
    case 'exprList': return { type: 'array', items: { $ref: '#/$defs/expr' } }
    case 'exprMap':  return { type: 'object', additionalProperties: { $ref: '#/$defs/expr' } }
    case 'name':     return { type: 'string' }
    case 'scalar':   return { type: ['string', 'number', 'boolean'] }
    case 'cmp':      return { enum: [...COMPARE_OPS] }
    case 'number':   return { type: 'number' }
  }
}

/** Emit the fixed schema as a standard JSON Schema document (draft 2020-12) —
 *  generated FROM OP_SCHEMA so it can never drift from the enforced contract. */
export function ruleJsonSchema(): Record<string, unknown> {
  const variants = Object.entries(OP_SCHEMA).map(([op, fields]) => {
    const properties: Record<string, unknown> = { op: { const: op } }
    const required = ['op']
    for (const [name, fs] of Object.entries(fields)) {
      properties[name] = kindToJsonSchema(fs.kind)
      if (fs.required) required.push(name)
    }
    return { type: 'object', properties, required, additionalProperties: false }
  })
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: `https://dqa.fieldos/rule.schema.v${RULE_SCHEMA_VERSION}.json`,
    title: 'FieldOS rule-as-data',
    description: `Fixed, versioned contract for a JSON rule. Schema version ${RULE_SCHEMA_VERSION}.`,
    type: 'object',
    required: ['id', 'on', 'expr'],
    additionalProperties: false,
    properties: {
      id: { type: 'string', minLength: 1 },
      on: { type: 'string', minLength: 1 },
      severity: { enum: [...SEVERITIES] },
      status: { enum: [...STATUSES] },
      category: { type: 'string' },
      schemaVersion: { const: RULE_SCHEMA_VERSION },
      expr: { $ref: '#/$defs/expr' },
      finding: {
        type: 'object',
        required: ['message'],
        additionalProperties: false,
        properties: { label: { $ref: '#/$defs/expr' }, delta: { $ref: '#/$defs/expr' }, message: { type: 'string' } },
      },
    },
    $defs: {
      expr: { type: 'object', required: ['op'], oneOf: variants },
    },
  }
}
