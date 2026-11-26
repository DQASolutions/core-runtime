// @dqa-ai-solutions/module-rule-registry — rule governance module.
// M1: types + pure resolve() + ports. Pg store adapter + template/channel layers land in M2/M3.

export * from './types.js'
export * from './tenant-registry.js'
export * from './store.js'
export type { Queryable } from './db.js'
export { resolveRuleSet, canonicalStringify } from './resolve.js'
export { detectConflicts } from './conflicts.js'
export { diffFindings, diffTemplateMembers, affectedRuleIds, overridesToReconfirm, backTestDiff, type BacktestFinding, type FindingsDiff, type MemberRef, type MemberDelta, type RuleWithIR } from './backtest.js'
export { matchesTemplate, suggestTemplates, type TemplateCriteria, type ClientAttrs } from './suggest.js'
export { PgRegistryStore } from './pg-store.js'
export { resolveForClient, resolveAndLock, detectConflictsForClient, suggestTemplatesForClient, promoteDraftToClientRule, promoteDraftToTemplateRule, publishTemplateVersion, moveChannel, rollbackChannel } from './service.js'
export type { RuleVersionRow } from './store.js'
