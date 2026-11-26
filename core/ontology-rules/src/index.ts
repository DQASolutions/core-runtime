export {
  compute,
  rule,
  action,
  isFnSpec,
  collectSpecs,
  type ComputeSpec,
  type RuleSpec,
  type ActionSpec,
  type FnSpec,
  type CollectedSpecs,
  type Finding,
  type RuleVerdict,
} from './fn.js'
export { loadFunctions, loadRuleStore, rulesByTypeFromIR, groupRulesByType, mergeRulesByType, overrideLast, type RulesByType } from './load-functions.js'
export {
  // CORE OPERATIONS — the closed primitive basis (guarded-FO + aggregation) every
  // rule composes from. See core-ops.ts for the theory: finite + closed ⇒ never
  // extended within the class; the only escapes are the named BOUNDARY primitives.
  num,
  text,
  bool,
  rel,
  all_of,
  filter,
  sum,
  count,
  min,
  max,
  avg,
  abs,
  eq,
  ne,
  lt,
  le,
  gt,
  ge,
  eqText,
  and,
  or,
  not,
  any,
  all,
  exists,
  isEmpty,
  ifElse,
  lookup,
  reach,
  daysBetween,
  startsWith,
  contains,
  type Node,
  type NodeSet,
  type Scalar,
  type Pred,
  type Proj,
} from './core-ops.js'
export {
  // EVAL-EXPR — interpreter for rules-as-DATA. evalExpr/evalBool run an ExprNode
  // JSON tree on the core-ops basis; ruleFromIR compiles a RuleIR into a RuleSpec.
  evalExpr,
  evalBool,
  ruleFromIR,
  paramResolver,
  EvalError,
  type ExprNode,
  type EvalCtx,
  type RuleIR,
  type RuleRuntime,
  type ComputeFn,
  type ParamResolver,
  type LawParameterRow,
} from './eval-expr.js'
export {
  // VALIDATE-RULE — deterministic completeness check on a rule-as-DATA draft.
  // validateRuleSpec returns the closed-option slots the UI must fill; [] = ready.
  validateRuleSpec,
  buildRegistry,
  type UnresolvedSlot,
  type PartialRuleSpec,
  type DomainRegistry,
  type RegistryOntology,
} from './validate-rule.js'
export {
  // RULE SCHEMA — the FIXED, versioned, enforced contract for a JSON rule.
  // OP_SCHEMA is the single closed source of truth; validate/assert gate at load.
  RULE_SCHEMA_VERSION,
  OP_SCHEMA,
  COMPARE_OPS,
  SEVERITIES,
  STATUSES,
  validateExprSchema,
  validateRuleIRSchema,
  assertRuleIRSchema,
  RuleSchemaError,
  ruleJsonSchema,
  type SchemaError,
} from './rule-schema.js'
export {
  // VALIDATE-ONTOLOGY — domain-agnostic soundness: structural (reach-to-leaf), empirical
  // (reconcile per relationship kind), and auto-generation of definitional reconciliation rules.
  REL_KINDS,
  validateOntologyStructure,
  scoreOntologyData,
  reconciliationRules,
  diagnoseOntology,
  diagnosisSummary,
  reconcileMismatches,
  type Diagnosis,
  type Waiver,
  type RelKind,
  type Fold,
  type RelDecl,
  type ReconcileSpec,
  type OntologyForSoundness,
  type SoundnessReport,
  type OntologyData,
  type RelScore,
  type ReconcileMiss,
  type ReconcileSkipped,
} from './validate-ontology.js'
