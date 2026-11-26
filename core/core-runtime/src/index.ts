// @dqa-ai-solutions/core-runtime — the part of the runtime every side needs, in one import: the
// ontology concepts and declarations, the value checks, the rule language and its interpreter, the
// schema surface, and the ports a backend implements. Pure: no Node builtin, no driver, no I/O — a
// server, a browser and a mobile build run the same checks and reach the same verdict.
//
// Running the ontology over a store (`createOntology`, the adapters, the loaders that read packs
// from disk, governance, the rule registry) is backend: @dqa-ai-solutions/ontology-runtime.
// Other entries: `./view` (the view contract a renderer draws), `./input` (typed form input),
// `./ontology-base` (declarations alone), `./kernel` (interpreter parts for the backend engine).
export * from '@dqa-ai-solutions/ontology-model'
export * from '@dqa-ai-solutions/ontology-rules'
