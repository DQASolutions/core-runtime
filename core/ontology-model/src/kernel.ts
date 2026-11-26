// @dqa-ai-solutions/ontology-model/kernel — the interpreter's working parts, for the backend engine
// (`Ontology` in @dqa-ai-solutions/ontology-runtime) that drives them over a store. Not an app API:
// an app reaches the same behaviour through `Ontology`, and these names may change with it.
export * from './index.js'
// Base's declarations again at this entry: a star re-export of an external package from a nested
// module bundles into a runtime copy, and ESM named imports (PROPERTY_TYPES…) would not exist.
export * from '@dqa-ai-solutions/ontology-base'
export * from './core/actions/action-runtime.js'
export * from './core/context/retrieve.js'
export * from './core/functions/function-runtime.js'
export * from './core/graph/traversal-planner.js'
export * from './core/graph/validation.js'
export * from './core/rules/condition-interpreter.js'
export * from './core/rules/evaluate.js'
export * from './core/rules/registry.js'
export * from './core/schema/schema-registry.js'
export * from './core/schema/surface.js'
export * from './core/schema/value-types.js'
export * from './ports/event-store.js'
export * from './ports/file-store.js'
export * from './ports/ontology-port.js'
export * from './ports/storage-adapter.js'
export * from './ports/vector-adapter.js'
export * from './shared/condition-match.js'
