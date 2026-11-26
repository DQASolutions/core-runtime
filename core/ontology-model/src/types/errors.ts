// Domain error codes (constitution: "domain error codes — no raw throws leaking
// backend errors"). Every guard throws an OntologyError carrying a stable code.

export type OntologyErrorCode =
  // provenance (NT3)
  | 'PROVENANCE_MISSING'
  | 'PROVENANCE_FIELD_REDECLARED'
  | 'RULE_PROVENANCE_MISSING'
  // schema
  | 'UNKNOWN_ENTITY_TYPE'
  | 'DUPLICATE_ENTITY_TYPE'
  | 'UNKNOWN_RELATIONSHIP_TYPE'
  | 'DUPLICATE_RELATIONSHIP_TYPE'
  | 'UNKNOWN_PROPERTY'
  | 'ENUM_VALUE_INVALID'
  | 'REQUIRED_PROPERTY_MISSING'
  | 'TYPE_MISMATCH'
  | 'INVALID_NAME'
  /** A value broke a constraint — declared (`maxLength`, `minimum`, `pattern`…)
   *  or the kernel's floor (default length ceiling, safe-integer range, no
   *  control characters). `details.keyword` names which, `details.limit` the bound. */
  | 'CONSTRAINT_VIOLATED'
  /** A property declared a constraint that cannot mean anything: `maxLength` on a
   *  number, `minimum` above `maximum`, a `pattern` that does not compile. */
  | 'INVALID_CONSTRAINT'
  // instances / edges
  | 'INSTANCE_NOT_FOUND'
  | 'ENDPOINT_TYPE_MISMATCH'
  | 'CARDINALITY_VIOLATION'
  // rules
  | 'UNKNOWN_RULE'
  | 'DUPLICATE_RULE'
  | 'INVALID_CONDITION_EXPR'
  | 'UNSUPPORTED_OP'
  | 'CUSTOM_EVALUATOR_NOT_FOUND'
  // actions (kinetic)
  | 'ACTION_NOT_FOUND'
  | 'ACTION_NOT_BOUND'
  | 'ACTION_GUARD_FAILED'
  /** A primitive write (create / upsert / update / link / unlink) was called
   *  outside an Action while the write gate is closed. Primitive writes emit no
   *  event, so the change would never reach the change log — the record moves
   *  and the ledger says it never did. See OntologyDeps.writeGate. */
  | 'WRITE_OUTSIDE_ACTION'
  /** migrate() was asked to apply a schema that is not additive against the
   *  baseline it was given — a removal, rename, narrowed type, dropped enum
   *  value or moved relationship endpoint. Stored events would stop decoding. */
  | 'BREAKING_SCHEMA_CHANGE'
  // functions (kinetic)
  | 'FUNCTION_NOT_FOUND'
  | 'FUNCTION_NOT_BOUND'
  // tenancy / config
  | 'TENANT_MISMATCH'
  | 'EMBED_NOT_CONFIGURED'
  /** An adapter was built whose driver package (pg, neo4j-driver,
   *  @qdrant/js-client-rest) is not installed. Drivers are optional peers. */
  | 'ADAPTER_DRIVER_MISSING'
  | 'MIGRATION_FAILED'
  // resource limits (DoS guards)
  | 'TRAVERSAL_LIMIT_EXCEEDED'
  | 'EVALUATION_LIMIT_EXCEEDED'

export class OntologyError extends Error {
  readonly code: OntologyErrorCode
  readonly details?: Record<string, unknown>
  /**
   * ⭐ `details.cause` ĐI THẲNG SANG `Error.cause` — thêm 5/9/2026.
   *
   *   Lỗi bọc mà mất nguyên nhân là lỗi không sửa được. Chỗ đau nhất đo được:
   *   `migrate()` bọc mọi lỗi của adapter thành một câu chung
   *   ("the storage adapter rejected the schema apply operation") và VỨT bản
   *   gốc — hai phiên mất một buổi tối vì lời báo không nói bảng nào, cột nào.
   *
   * ⛔ KHÔNG PHÁ LUẬT KHÔNG-RÒ. `message` vẫn chung chung y như cũ; `cause` là
   *    một ô lập trình, không nằm trong lời báo, và ai đọc được nó thì đã ở
   *    trong tiến trình rồi. Hai thứ ấy khác nhau và trước đây bị gộp làm một.
   */
  constructor(code: OntologyErrorCode, message: string, details?: Record<string, unknown>) {
    super(`[${code}] ${message}`, details && 'cause' in details ? { cause: details.cause } : undefined)
    this.name = 'OntologyError'
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export class ProvenanceError extends OntologyError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('PROVENANCE_MISSING', message, details)
    this.name = 'ProvenanceError'
  }
}

export function ontologyError(
  code: OntologyErrorCode,
  message: string,
  details?: Record<string, unknown>,
): OntologyError {
  return new OntologyError(code, message, details)
}
