// Rule & Evaluation context (Layer 2) — rules are stored DATA, never code (NT4).
// registerRule validates provenance + condition + appliesTo; disableRule is soft
// and bumps the version (BR-009) — history is never destroyed.

import {
  type RuleDef,
  type RuleKind,
  isCompleteProvenance,
  ontologyError,
} from '../../types/index.js'
import type { Provenance } from '../../types/index.js'
import type { StorageAdapter } from '../../ports/storage-adapter.js'
import { validateCondition } from './condition-interpreter.js'

const VALID_KINDS = new Set<RuleKind>(['CROSS_CHECK', 'REQUIRED_RELATION', 'EXISTENCE_IMPLIES', 'SEQUENCE', 'AGGREGATE', 'CUSTOM'])

/**
 * Validate and persist a new RuleDef.
 *
 * @param rule        — the full RuleDef to register
 * @param adapter     — tenant-scoped StorageAdapter
 * @param knownTypes  — optional set of known EntityType/RelationshipType names for appliesTo validation
 */
// @impl BR-008, S007-AC-001, S007-AC-005, S007-AC-006
export async function registerRule(
  rule: RuleDef,
  adapter: StorageAdapter,
  knownTypes?: Set<string>,
): Promise<void> {
  if (typeof rule.id !== 'string' || rule.id.trim().length === 0) {
    throw ontologyError('INVALID_CONDITION_EXPR', 'RuleDef.id is required')
  }
  if (!VALID_KINDS.has(rule.kind)) {
    throw ontologyError('INVALID_CONDITION_EXPR', `Unknown RuleKind "${rule.kind}"`)
  }
  // FR-N02 / FR-E01: rule provenance fields are required and must be non-empty
  // @impl BR-001
  const ruleProv = {
    source_ref: rule.source_ref,
    confirmed_by: rule.confirmed_by,
    confirmed_at: rule.confirmed_at,
  }
  if (!isCompleteProvenance(ruleProv)) {
    throw ontologyError(
      'RULE_PROVENANCE_MISSING',
      `Rule "${rule.id}" is missing provenance (source_ref + confirmed_by + confirmed_at)`,
    )
  }
  // FR-E02: appliesTo must reference a known EntityType or RelationshipType
  if (knownTypes !== undefined && !knownTypes.has(rule.appliesTo)) {
    throw ontologyError(
      'UNKNOWN_ENTITY_TYPE',
      `Rule "${rule.id}" appliesTo "${rule.appliesTo}" does not match any registered EntityType or RelationshipType`,
    )
  }
  // FR-N04 / FR-E03: condition tree must use valid op values
  validateCondition(rule.condition)

  // FR-E06: re-registration of an existing id is rejected (DUPLICATE_ENTITY_TYPE per spec FR-E06).
  // Use the atomic variant when available to prevent TOCTOU races under concurrent callers.
  if (typeof adapter.insertRuleIfAbsent === 'function') {
    const inserted = await adapter.insertRuleIfAbsent({ ...rule, version: 1, enabled: rule.enabled ?? true })
    if (!inserted) throw ontologyError('DUPLICATE_ENTITY_TYPE', `Rule "${rule.id}" already registered`)
    return
  }
  const existing = await adapter.getRule(rule.id)
  if (existing) {
    throw ontologyError('DUPLICATE_ENTITY_TYPE', `Rule "${rule.id}" already registered`)
  }
  await adapter.insertRule({ ...rule, version: 1, enabled: rule.enabled ?? true })
// @impl S007-AC-007, S007-AC-011
}
// @impl S007-AC-007, S007-AC-011

// @impl S007-AC-007, S007-AC-011
export async function listRules(
  adapter: StorageAdapter,
  filter?: { appliesTo?: string; enabled?: boolean; kind?: RuleKind },
): Promise<RuleDef[]> {
  // The adapter handles appliesTo + enabled; kind filtering happens here if needed.
  const q: { appliesTo?: string; enabled?: boolean } = {}
  if (filter?.appliesTo !== undefined) q.appliesTo = filter.appliesTo
  if (filter?.enabled !== undefined) q.enabled = filter.enabled
  const raw = await adapter.queryRules(Object.keys(q).length ? q : undefined)
  if (filter?.kind !== undefined) {
    return raw.filter((r) => r.kind === filter.kind)
  }
  // @impl BR-009
  return raw
// @impl BR-009
}

// @impl BR-009
export async function disableRule(
  id: string,
  prov: Provenance,
  adapter: StorageAdapter,
): Promise<void> {
  if (!isCompleteProvenance(prov)) {
    throw ontologyError('PROVENANCE_MISSING', `disableRule("${id}") requires provenance`)
  }
  // Use the atomic variant when available to prevent TOCTOU races (version skew) under concurrent callers.
  if (typeof adapter.atomicDisableRule === 'function') {
    const result = await adapter.atomicDisableRule(id, prov)
    if (result === 'not_found') throw ontologyError('UNKNOWN_RULE', `Unknown rule "${id}"`)
    return
  }
  const rule = await adapter.getRule(id)
  if (!rule) throw ontologyError('UNKNOWN_RULE', `Unknown rule "${id}"`)
  await adapter.updateRule({
    ...rule,
    enabled: false,
    version: rule.version + 1,
    source_ref: prov.source_ref,
    confirmed_by: prov.confirmed_by,
    confirmed_at: prov.confirmed_at,
  })
}
