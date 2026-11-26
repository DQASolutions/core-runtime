// Shared kernel: the ontology vocabulary every layer speaks. Importable by
// api, core, AND adapters (a dedicated zone below the layer boundary so that
// Layer-1 adapters can use Instance/Edge/ConditionExpr without importing core).
export * from './concepts.js'
export * from './provenance.js'
export * from './errors.js'
export * from './kinetic.js'
