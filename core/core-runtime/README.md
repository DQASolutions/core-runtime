# @dqa-ai-solutions/core-runtime

The shared core of the DQA runtime: the part a server, a browser and a mobile build all need, and run
the same way. The ontology concepts and declarations, the value checks, the rule language and its
interpreter, the schema surface, the ports a backend implements, and the view contract a renderer
draws. Pure: no Node builtin, no database driver, no I/O.

Running the ontology over a store — `createOntology`, the storage adapters, the loaders that read
packs from disk, governance, the rule registry — is `@dqa-ai-solutions/ontology-runtime`, which
re-exports this package.

```bash
npm i @dqa-ai-solutions/core-runtime
```

| Import | What |
|---|---|
| `@dqa-ai-solutions/core-runtime` | concepts and errors, value checks (`checkPropertyValue`, `validateInstanceData`…), rules (`evalExpr`, `compute`, `rule`, `action`, `rulesByTypeFromIR`…), schema surface, the ports (`StorageAdapter`, `FileStore`, `EventStore`, `OntologyPort`…) |
| `@dqa-ai-solutions/core-runtime/view` | the view contract: what an app declares about a screen, and the `ViewContract` a renderer receives |
| `@dqa-ai-solutions/core-runtime/input` | typed form input (`parseTypedInput`, `checkPropertyValue`…) |
| `@dqa-ai-solutions/core-runtime/ontology-base` | declarations only: value types, entity and relationship types, rule and event signatures |
| `@dqa-ai-solutions/core-runtime/ontology-base/schema/ontology-file.schema.json` (`.yaml`) | the ontology file format as JSON Schema |
| `@dqa-ai-solutions/core-runtime/ontology-base/conformance/cases.yaml` | language-neutral conformance cases |
| `@dqa-ai-solutions/core-runtime/kernel` | the interpreter's working parts, for the backend engine; not an app API |

Every entry loads in a browser. ES modules only.
