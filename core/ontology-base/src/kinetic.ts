// Kinetic-ontology vocabulary — the verbs (Actions), computations (Functions),
// neutral rule results, and write events the DQA FieldOS needs on top of the
// current entity/edge/rule store. Plain types (validated at the runtime layer);
// no domain terms (check:qg4) and no infra deps (check:qg2).

import type { ConditionExpr, TraversalResult } from './concepts.js'

/** A value that can flow through Action/Function params + results + events. */
export type Value = string | number | boolean | null | Value[] | { [k: string]: Value }

/** A named bag of arguments to an Action or Function. */
export type Args = Record<string, Value>

/** Declared parameter shape (signature only; bodies are app-supplied SPI). */
export interface ParamDef {
  type: string
  optional?: boolean
  description?: string
}

/**
 * Signature of a governed write verb — the ONLY way to mutate the graph.
 * `createInstance` / `link` are themselves built-in Actions. The guard
 * (submission-criteria) + effect body are supplied by the runtime / app SPI.
 */
export interface ActionTypeDef {
  name: string
  params?: Record<string, ParamDef>
  description?: string
}

/**
 * Signature of a named, deterministic, reusable computation over the graph
 * (a "named formula"). Pure + memoizable. Body is app-supplied SPI.
 */
export interface FunctionTypeDef {
  name: string
  inputs?: Record<string, ParamDef>
  returns?: string
  description?: string
}

/**
 * An append-only event emitted by an Action — the write-log unit the host's
 * reaction engine subscribes to. (Named `OntologyEvent`, not `Event`, to avoid
 * clashing with the DOM global.)
 */
export interface OntologyEvent {
  id: string
  ts: string // ISO 8601
  type: string // e.g. 'instance.created' or the Action name
  aggregate: string // affected instance id
  payload: Value
  actor: string // Ctx.actor
  version: number
  /**
   * BƯỚC nào sinh ra sự kiện này — do `applyAction` đóng dấu, không do hiệu ứng
   * tự khai. Kernel là bên duy nhất biết chắc, vì nó là bên áp bước.
   *
   * ⚠️ Không nhầm với `type`: `type` là lời của MIỀN nghiệp vụ, app tự đặt
   * (`trainingEvent.approved`). `action` là tên bước trong khai báo quy trình.
   * Phát lại nhật ký qua đồ thị cần cái sau; đoán cái trước theo quy ước đặt tên
   * là chỗ hỏng.
   */
  action?: string
}

/** Declarative outcome-intent carried on a rule — DATA only; the SDK never runs it. */
export interface RuleOnFail {
  action?: string
  params?: Args
  severityLabel?: string
}

/**
 * Neutral result of evaluating one rule against one target. No flag rendering,
 * no severity interpretation, no persistence, no auto-run — detection only.
 * Reaction (if any) is decided later by the host via `onFail` intent.
 */
export interface RuleResult {
  ruleId: string
  target: string // instance id the rule was evaluated against
  fired: boolean
  severityLabel?: string // opaque label carried from RuleDef; SDK does not interpret it
  message?: string
  onFail?: RuleOnFail
  /** Best-effort evidence trace for why the rule fired (audit/provenance). */
  trace?: TraversalResult
}

/** Unified object-query: filter · traverse · aggregate (the agent command-set read). */
export interface QuerySpec {
  type: string
  where?: ConditionExpr
  traverse?: Array<{ relationship: string; direction?: 'out' | 'in' }>
  aggregate?: { fn: 'sum' | 'count' | 'max' | 'min'; field?: string; groupBy?: string[] }
  limit?: number
}
