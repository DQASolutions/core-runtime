// Package entry / composition root. Consumers import the API + the concrete
// adapter(s) they choose, then wire them via createOntology({ adapter, ... }).

// Public API (Layer 3)
export { Ontology, createOntology, type OntologyDeps, type ContextOpts } from './api/index.js'

// The ontology vocabulary (shared kernel) — incl. kinetic types
// (ActionTypeDef · FunctionTypeDef · RuleResult · OntologyEvent · QuerySpec).
export * from './types/index.js'
// Base's declarations, re-exported here at the entry as well as in types/: the
// bundler turns a star re-export of an external package that sits in a nested
// module into a runtime copy, so ESM named imports (PROPERTY_TYPES, RULE_KINDS…)
// would not exist. At the entry it stays a real `export * from`.
export * from '@dqa-ai-solutions/ontology-base'

// Primary port — the single contract hosts and apps program against (driving
// side). The `Ontology` class implements it, including the kinetic methods
// (applyAction/callFunction/defineAction/defineFunction + evaluateRules →
// RuleResult[]).
export type { OntologyPort, IngestBulkPayload, IngestBulkResult } from './ports/ontology-port.js'

// Kinetic SPI types — for binding Function/Action bodies (`defineFunctionImpl`/
// `defineActionImpl`) and for code that reads the IO surface a body receives.
export type { FunctionIO, FunctionImpl } from './core/functions/function-runtime.js'
export type { ActionIO, ActionImpl, EventSeed, GuardResult } from './core/actions/action-runtime.js'

// The additive-only guarantee (M2 replay). `schemaSurface` reduces a schema to
// what a stored event can depend on; `breakingChanges` says what would strand
// one. Hand a surface to `migrate({ baseline })` and the kernel refuses a
// non-additive change, instead of every app policing it by convention.
export {
  schemaSurface,
  breakingChanges,
  formatBreakingChanges,
  type SchemaSurface,
  type BreakingChange,
} from './core/schema/surface.js'
export type { MigrateOptions } from './api/ontology.js'

// Adapter contracts (for those writing their own backend — driven side)
export type {
  StorageAdapter,
  EdgeQuery,
  MultiEdgeQuery,
  Row,
  UnitOfWork,
} from './ports/storage-adapter.js'
export type {
  VectorAdapter,
  VectorItem,
  VectorHit,
  EmbedFn,
} from './ports/vector-adapter.js'

// FileStore port — resolves the `file` PropertyType introduced in 5.5.0. Like
// VectorAdapter, an entirely separate capability: an ontology with no `file`
// property needs no FileStore at all.
export type { FileStore } from './ports/file-store.js'
export { assertFileKey, FileKeyError } from './ports/file-store.js'

// EventStore port (M2) — the durable, replayable change log. Postgres is one
// adapter; Null (explicit no-op) + InMemory (test/dev) ship alongside.
export type { EventStore } from './ports/event-store.js'
export type { ChainVerdict } from './adapters/event-store/hash-chain.js'
export { NullEventStore } from './adapters/event-store/null-event-store.js'
export { InMemoryEventStore } from './adapters/event-store/in-memory-event-store.js'
export { PostgresEventStore } from './adapters/event-store/postgres-event-store.js'

// Instance-data validation (Layer 2) — the single source of truth for
// well-formedness. `validateInstanceData` is the write-time guard (throws on
// first error); `collectInstanceDataErrors` is the collect-all form a pre-flight
// handoff validator uses to surface every problem at once.
export {
  validateInstanceData,
  collectInstanceDataErrors,
  constraintDeclarationError,
  checkPropertyValue,
  fileViolation,
  isIsoDate,
  isIsoDateTime,
  type ValueViolation,
} from './core/graph/validation.js'

// Value types — a named set of constraints, declared once (Foundry's Value Types).
export { resolveValueTypes, type ValueTypeDef } from './core/schema/value-types.js'

// Which properties have not said what a valid value is.

// Typed input → wire value, with the guard applied (also at `@dqa-ai-solutions/ontology-sdk/input`).
export { parseTypedInput, type ParseResult, type ParseOptions, type ParseFailureReason } from './input/typed-input.js'

// Deterministic ids — the seam that makes ingest idempotent (same ref → same id).
export { idFor, uuidv5 } from './shared/deterministic-id.js'

// Operator surface — flat SQL views generated from the ontology, so an
// administrator can read the store with plain SQL instead of jsonb operators.
export {
  buildViewsDDL,
  buildViewsSQL,
  type BuildViewsOptions,
} from './adapters/postgres/views.js'

// v1 adapters
export { InMemoryAdapter } from './adapters/in-memory/in-memory-adapter.js'
export { PostgresAdapter, type PostgresAdapterOptions } from './adapters/postgres/postgres-adapter.js'
// Native relational storage — same contract, real tables instead of jsonb.
export {
  NativeTableAdapter,
  type NativeTableAdapterOptions,
} from './adapters/postgres/native-table-adapter.js'
export {
  buildNativeDDL,
  linkPlacement,
  tableFor,
  joinTableFor,
  fkColumnFor,
  type BuildNativeDDLOptions,
} from './adapters/postgres/native-ddl.js'
export { buildNativeViewsSQL } from './adapters/postgres/native-views.js'
export { QdrantVectorAdapter, type QdrantAdapterOptions } from './adapters/qdrant/qdrant-adapter.js'
export { FilesystemAdapter } from './adapters/filesystem/filesystem-adapter.js'
export { Neo4jAdapter, type Neo4jAdapterOptions } from './adapters/neo4j/neo4j-adapter.js'

// FileStore adapters — a directory for a single node, an S3-compatible object
// store (MinIO/Ceph/AWS) for every other case. Neither needs a peer dependency.
export { LocalFileStore, type LocalFileStoreOptions } from './adapters/local-files/local-file-store.js'
export { S3FileStore, type S3FileStoreOptions } from './adapters/s3/s3-file-store.js'
