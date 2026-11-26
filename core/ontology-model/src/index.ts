// @dqa-ai-solutions/ontology-model — the part of the ontology every side needs: the concepts, the
// value checks, the rule and condition interpreter, the schema surface, and the ports a backend
// implements. Pure: no Node builtin, no driver, no I/O — a browser, a server and a mobile build load
// the same code and reach the same verdict.
//
// The engine that runs these over a store (`Ontology`, the adapters, the write gate) is backend
// and lives in @dqa-ai-solutions/ontology-runtime.

export * from './types/index.js'
export * from '@dqa-ai-solutions/ontology-base'

export type { OntologyPort, IngestBulkPayload, IngestBulkResult } from './ports/ontology-port.js'

export type { FunctionIO, FunctionImpl } from './core/functions/function-runtime.js'
export type { ActionIO, ActionImpl, EventSeed, GuardResult } from './core/actions/action-runtime.js'

export {
  schemaSurface,
  breakingChanges,
  formatBreakingChanges,
  type SchemaSurface,
  type BreakingChange,
} from './core/schema/surface.js'

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

export type { FileStore } from './ports/file-store.js'
export { assertFileKey, FileKeyError } from './ports/file-store.js'

export type { EventStore, ChainVerdict } from './ports/event-store.js'

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

export { resolveValueTypes, type ValueTypeDef } from './core/schema/value-types.js'

export { parseTypedInput, type ParseResult, type ParseOptions, type ParseFailureReason } from './input/typed-input.js'
