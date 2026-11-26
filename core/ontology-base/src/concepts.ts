// The SDK's five first-class concepts + their supporting value objects.
// Pure TypeScript — no backend, no I/O. This is the "language" of the SDK
// (source-spec §2). Layer 1/2/3 all speak in these types and nothing lower.

export type PropertyType =
  | 'text'
  | 'number'
  | 'date'
  | 'datetime'
  | 'enum'
  | 'uuid'
  | 'json'
  | 'text[]'
  /**
   * A reference to a stored file — a scan, a photo, an attachment.
   *
   * The value is a path within the caller's file store, so on the wire it is a
   * string like `text`. It is a distinct type because *what the value means*
   * differs, and three layers act on that meaning:
   *
   *   · the UI renders an upload control instead of a text box;
   *   · the caller can verify the file actually exists before accepting a write
   *     — a plain `text` field accepts `abc.png` from a typo and never notices;
   *   · an audit can enumerate every piece of scanned evidence in the ontology
   *     without a naming convention such as `*ScanPath`.
   *
   * The SDK deliberately does NOT check existence: it owns no file store and
   * has no port for one. It validates the *shape* (a non-empty path); proving
   * the bytes are there belongs to whoever owns the store.
   */
  | 'file'
  /**
   * A value drawn from a CATALOGUE — a list that lives as rows in the store,
   * not as literals in the schema.
   *
   * `enum` and `catalogue` look alike and are not. The question that separates
   * them is *who owns the list*:
   *
   *   · `enum` — the SCHEMA owns it. The values are part of what the model
   *     means: a lifecycle's states, a yes/no, an outcome. Changing the list
   *     changes what the model *is*, so it belongs in a schema change.
   *   · `catalogue` — the WORLD owns it. Job grades, org levels, document kinds,
   *     administrative areas: lists a law, a decree or a registry publishes and
   *     later amends. The model's meaning does not move when a row is added.
   *
   * Declaring the second kind as `enum` makes every amendment a schema change,
   * a redeploy, and — where nodes may run behind — a breaking change. That is
   * the wrong price for a fact that was always data. It also puts the list
   * out of reach of the people who maintain it: an administrator can edit a
   * table, not a compiled schema.
   *
   * The value is the catalogue row's key, so on the wire it is a string like
   * `text`. `catalogue` names the collection the key must be found in. The SDK
   * validates only the *shape* — a non-empty key — deliberately, and for the
   * same reason as `file`: it owns no catalogue store and has no port to one.
   * Proving the row exists belongs to whoever owns the store, which can answer
   * it against live rows instead of against a compiled-in copy.
   */
  | 'catalogue'

export interface PropertyDef {
  name: string
  type: PropertyType
  enumValues?: string[] // required when type === 'enum'
  /** Collection whose rows are the allowed values — required when type === 'catalogue'. */
  catalogue?: string
  required?: boolean
  description?: string // living documentation — chatbot/AI reads this

  // ── Value constraints — JSON Schema's validation keywords, borrowed whole ──
  //
  // Checked on every write (create, upsert, update) by validateInstanceData, and
  // checked for sense when the type is defined (INVALID_CONSTRAINT). A violated
  // one throws CONSTRAINT_VIOLATED with `details.keyword` = the keyword's name.
  //
  // Undeclared does NOT mean unlimited: text-like values are capped at
  // DEFAULT_TEXT_MAX_LENGTH, lists at DEFAULT_MAX_ITEMS, numbers at the safe
  // integer range. Declaring a keyword replaces the default, in either direction.

  /** text · file · catalogue · each text[] element — counted in characters, after trimming. */
  minLength?: number
  /** text · file · catalogue · each text[] element — counted in characters. */
  maxLength?: number
  /** text · each text[] element — an ECMAScript regex, tested as written (anchor it yourself). */
  pattern?: string
  /** number */
  minimum?: number
  /** number */
  maximum?: number
  /** number — the value must be strictly greater. */
  exclusiveMinimum?: number
  /** number — the value must be strictly less. */
  exclusiveMaximum?: number
  /** number — `1` for a count; `0.01` for money in cents. Float-tolerant. */
  multipleOf?: number
  /** text[] */
  minItems?: number
  /** text[] */
  maxItems?: number
  /**
   * date · datetime — the earliest value, written in the type's own form
   * (`1900-01-01`, `2026-01-01T00:00:00Z`). JSON Schema's name for a bound on a
   * formatted string (ajv-formats). A date box without one takes year 20266.
   */
  formatMinimum?: string
  /** date · datetime — the latest value, in the type's own form. */
  formatMaximum?: string
  /**
   * file — the kinds a person may attach: MIME types (`application/pdf`,
   * `image/*`) or extensions (`.pdf`). Becomes the box's `accept`. The store only
   * keeps a path, so the WRITE guard cannot see the bytes: the element enforces
   * this on pick AND drop, and the upload endpoint checks the same list with
   * {@link fileViolation} before it writes anything.
   */
  accept?: string[]
  /**
   * file — the largest file, in bytes. HTML has no attribute for it, so without
   * a declared number a 400 MB video reaches the server before anyone says no.
   */
  maxBytes?: number
  /**
   * The name of a declared value type (see `resolveValueTypes`) whose
   * constraints this property takes. Must be resolved before the type is
   * defined — an unresolved one is refused.
   */
  valueType?: string
  /** Set by `resolveValueTypes`: which value type the constraints came from. */
  valueTypeOf?: string
}

/**
 * Ceiling on a text-like value whose property declares no `maxLength`.
 *
 * A property that declares nothing is not a property that accepts a pasted
 * log. 4000 is the widest box a form offers (a multi-line field), so what a
 * person can type is what the store accepts. A property that truly holds more
 * — a body of rich text — says so with its own `maxLength`.
 */
export const DEFAULT_TEXT_MAX_LENGTH = 4000
/** Ceiling on the number of elements of a `text[]` that declares no `maxItems`. */
export const DEFAULT_MAX_ITEMS = 1000
/** Ceiling on the serialized length of a `json` value. */
export const DEFAULT_JSON_MAX_LENGTH = 1_000_000

/**
 * A *kind of thing*. The caller never declares provenance fields — the SDK
 * injects id/source_ref/confirmed_by/confirmed_at automatically (NT3) and
 * rejects any attempt to declare them (PROVENANCE_FIELD_REDECLARED).
 */
export interface EntityTypeDef {
  name: string // ontology identifier, e.g. "chung_tu"
  label: string
  properties: PropertyDef[]
}

export type Cardinality = '1..1' | '1..N' | 'N..1' | 'N..N'

/** A *kind of edge* connecting two EntityTypes, with direction + cardinality. */
export interface RelationshipTypeDef {
  name: string // e.g. "chung_minh"
  from: string // EntityType name
  to: string // EntityType name
  cardinality: Cardinality
  directed: boolean
  description?: string
}

/** The four provenance fields the SDK injects into every EntityType (NT3). */
export const PROVENANCE_FIELDS = ['id', 'source_ref', 'confirmed_by', 'confirmed_at'] as const
export type ProvenanceField = (typeof PROVENANCE_FIELDS)[number]

/** A concrete thing of an EntityType. `data` holds the typed property bag. */
export interface Instance {
  id: string
  entityType: string
  data: Record<string, unknown>
  /** Nested provenance object (FR-D03, STORY-004). The SDK injects this on every create/update. */
  provenance: {
    source_ref: string
    confirmed_by: string
    confirmed_at: string // ISO 8601
  }
  // Flat aliases kept for backward-compat with internal code that reads these directly.
  source_ref: string
  confirmed_by: string
  confirmed_at: string // ISO 8601
}

/** A concrete edge of a RelationshipType connecting two Instances. */
export interface Edge {
  id: string
  relationship: string
  fromId: string
  toId: string
  /** Nested provenance object (FR-D01, STORY-005). The SDK injects this on every link(). */
  provenance: {
    source_ref: string
    confirmed_by: string
    confirmed_at: string // ISO 8601
  }
  // Flat aliases kept for backward-compat with internal code that reads these directly.
  source_ref: string
  confirmed_by: string
  confirmed_at: string // ISO 8601
}

// ── Rules (NT4 — rules are DATA, not code) ──────────────────────────────────

/**
 * Every rule kind, as DATA — so the storage layer builds its CHECK constraint
 * from this list instead of keeping a second copy.
 *
 * There was a second copy, and it drifted: `AGGREGATE` existed in the type but
 * was missing from the Postgres CHECK, so a rule the compiler accepted and
 * other backends ran was rejected by the database — a defect that surfaced only
 * on the one backend intended for production.
 */
/**
 * ⭐ DANH SÁCH CHẠY ĐƯỢC của `PropertyType` — thêm 5/9/2026.
 *
 *   `PropertyType` là union chỉ có lúc biên dịch, nên tầng SQL phải gõ lại danh
 *   sách ấy vào một `CHECK`. Hai bản chép, và chúng ĐÃ trôi khỏi nhau: 5.9.0
 *   thêm `'catalogue'` vào union và vào câu `CREATE TABLE`, nhưng mọi kho đã
 *   dựng từ trước không bao giờ nhận cột — `CREATE TABLE IF NOT EXISTS` là
 *   no-op — và lượt ghi kế tiếp đâm vào một cột không có.
 *
 * ⛔ ĐỪNG THÊM MỘT KIỂU CHỈ Ở UNION. Thêm vào đây; union suy ra từ đây, và
 *    `buildInitDDL` cũng đọc từ đây. Một danh sách, không có bản chép nào.
 */
export const PROPERTY_TYPES = [
  'text', 'number', 'date', 'datetime', 'enum', 'uuid', 'json', 'text[]', 'file', 'catalogue',
] as const

/**
 * ⛔ HAI CHIỀU, KHÔNG PHẢI MỘT. Chỉ chấm một chiều thì thêm một kiểu vào union
 *    mà quên mảng vẫn lọt — đúng cách `catalogue` đã lọt. `tsc` chặn cả hai.
 */
type _PropertyTypesCoverUnion = PropertyType extends (typeof PROPERTY_TYPES)[number] ? true : never
type _UnionCoversPropertyTypes = (typeof PROPERTY_TYPES)[number] extends PropertyType ? true : never
const _propertyTypesInStep: [_PropertyTypesCoverUnion, _UnionCoversPropertyTypes] = [true, true]
void _propertyTypesInStep

export const RULE_KINDS = [
  'CROSS_CHECK', // R1: compare two sources of one indicator; flag if |Δ| > ε
  'REQUIRED_RELATION', // R2: an instance of X must have (enough) edges of type Y
  'EXISTENCE_IMPLIES', // R6/R8: existence of X ⇒ a Y satisfying Z must exist
  'SEQUENCE', // R7: step A must occur before step B
  'AGGREGATE', // group instances → sum/count a field → flag groups crossing a threshold
  'CUSTOM', // escape hatch: a registered evaluator
] as const

export type RuleKind = (typeof RULE_KINDS)[number]

export type CompareOp = '=' | '!=' | '>' | '<' | '>=' | '<='

export type ValueRef =
  | { kind: 'property'; entity: string; name: string }
  | { kind: 'aggregate'; fn: 'sum' | 'count'; over: string; property?: string }
  | { kind: 'literal'; value: number | string | boolean }
  | { kind: 'sourceValue'; source: string; metric: string } // a number from an external source

/**
 * Which end of an edge the instance under evaluation sits at.
 *
 * `out` (the default, and the only behaviour there used to be) counts edges
 * leaving the instance. That default forced the modelling: a rule that needed
 * to ask "does anything point AT me" could only be written by declaring the
 * relationship the other way round, so edge direction ended up chosen by what
 * some rule needed rather than by what the relationship means.
 *
 * `in` counts edges arriving; `either` counts both, an edge with the instance
 * at both ends counting once.
 */
export type EdgeDirection = 'out' | 'in' | 'either'

/** A serializable boolean expression tree (stored as JSON in the rule store). */
export type ConditionExpr =
  | { op: 'and' | 'or'; clauses: ConditionExpr[] }
  | { op: 'not'; clause: ConditionExpr }
  | { op: 'compare'; left: ValueRef; cmp: CompareOp; right: ValueRef }
  | { op: 'exists'; relationship: string; where?: ConditionExpr; direction?: EdgeDirection }
  | { op: 'absent'; relationship: string; where?: ConditionExpr; direction?: EdgeDirection } // R6/R8 — meaningful absence
  | { op: 'count'; relationship: string; cmp: CompareOp; n: number; direction?: EdgeDirection }
  // AGGREGATE — group candidate instances by `groupBy` property values, then
  // sum `field` (or count) per group; a group whose aggregate satisfies
  // `cmp threshold` flags every instance in it. (e.g. ≥20m cash / supplier / day)
  | { op: 'aggregate'; groupBy: string[]; fn: 'sum' | 'count'; field?: string; cmp: CompareOp; threshold: number }

export interface RuleDef {
  id: string
  name: string
  kind: RuleKind
  appliesTo: string // EntityType / RelationshipType name
  condition: ConditionExpr
  severity: string // the app's own levels; the kernel attaches no meaning to the word
  message: string // render template for a fired flag
  // provenance of the rule itself (NT4):
  source_ref: string
  confirmed_by: string
  confirmed_at: string // ISO 8601
  enabled: boolean
  version: number // starts at 1; disableRule bumps it; history is never deleted
  /**
   * Declarative outcome-intent carried through to RuleResult.onFail when the
   * rule fires. DATA only — the SDK never executes it (detection ≠ reaction;
   * the host's reaction layer / a workflow step decides what to do). Optional +
   * additive — pre-kinetic rules omit it.
   */
  onFail?: import('./kinetic.js').RuleOnFail
}

// ── Traversal ───────────────────────────────────────────────────────────────

export interface TraverseSpec {
  start: string
  path: string[] // chain of relationship names
  direction: 'forward' | 'backward'
  where?: ConditionExpr
}

export interface TraversalStep {
  edge: Edge
  node: Instance
}

export interface TraversalResult {
  start: string
  path: string[]
  direction: 'forward' | 'backward'
  /** Ordered list of paths walked (each path is the ordered steps from start). */
  paths: TraversalStep[][]
  /** Flat de-duplicated set of nodes reached, in first-visit order. nodes[0] is always the start instance (FR-N08). */
  nodes: Instance[]
  /** Flat list of edges traversed in order, length is always nodes.length - 1 for a linear path (FR-D01). */
  edges: Edge[]
}

// ── Rule evaluation output ──────────────────────────────────────────────────

export interface Flag {
  ruleId: string
  ruleName: string
  instanceId: string
  entityType: string
  severity: string
  message: string // rendered
  trace: TraversalResult // always present — FR-D01; minimal (nodes[0] only) when no path exists (FR-E06)
}

export interface EvalScope {
  tenantId: string
  entityType?: string
  where?: ConditionExpr
  ids?: string[]
  period?: { from: string; to: string } // ISO 8601 date range (A-011)
}

// ── Schema + migration ──────────────────────────────────────────────────────

export interface OntologySchema {
  entityTypes: EntityTypeDef[]
  relationshipTypes: RelationshipTypeDef[]
}

/** One entry in MigrationReport.changes — adapter-defined but must carry type/name/op. */
export interface MigrationChange {
  type: 'EntityType' | 'RelationshipType'
  name: string
  op: 'created' | 'no-op' | string // adapter may add values; 'created' and 'no-op' are standard
}

/** One entry in MigrationReport.errors — adapter-defined error codes (not SDK domain codes). */
export interface MigrationError {
  code: string
  message: string
}

/**
 * Returned by StorageAdapter.applySchema and surfaced to callers via ontology.migrate().
 * FR-N02: appliedAt is ISO 8601, changes lists one entry per type applied,
 * errors is empty on full success.
 */
export interface MigrationReport {
  /** ISO 8601 timestamp of the moment the adapter completed applySchema. */
  appliedAt: string
  /** One entry per EntityType or RelationshipType applied (FR-D02). */
  changes: MigrationChange[]
  /**
   * Adapter-defined errors; empty array on full success (FR-N02).
   * Non-empty means a partial failure; migrate() still resolves (FR-E05).
   */
  errors: MigrationError[]
}

// ── Context retrieval (NT5) ─────────────────────────────────────────────────

export interface Chunk {
  id: string
  text: string
  score: number
  meta: Record<string, unknown>
}

export interface ContextBundle {
  structured: {
    instances: Instance[]
    edges: Edge[]
    rules: RuleDef[]
  }
  documents: Chunk[]
}
