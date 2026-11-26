# @dqa-ai-solutions/core-runtime

The core tier of the DQA runtime: the ontology SDK, the rule language, the pack loaders, the storage
builders, governance and the rule registry. No process runner, no views, no agent.

```bash
npm i @dqa-ai-solutions/core-runtime
```

| Import | What |
|---|---|
| `@dqa-ai-solutions/core-runtime` | `createOntology`, adapters (memory, filesystem, postgres, neo4j, qdrant), rules (`evalExpr`, `compute`, `rule`, `action`), `loadOntology`/`loadRules`/`loadOntologyFiles`, `buildStorage`/`buildFileStore`, governance, rule registry |
| `@dqa-ai-solutions/core-runtime/input` | typed-input checks of the SDK (`parseTypedInput`, `checkPropertyValue`…), safe to load in a browser |
| `@dqa-ai-solutions/core-runtime/ontology-base` | declarations only: value types, entity and relationship types, rule and event signatures |
| `@dqa-ai-solutions/core-runtime/ontology-base/schema/ontology-file.schema.json` (`.yaml`) | the ontology file format as JSON Schema |
| `@dqa-ai-solutions/core-runtime/ontology-base/conformance/cases.yaml` | language-neutral conformance cases |
| `@dqa-ai-solutions/core-runtime/rule-registry/migrations/*` | SQL migrations for the rule registry's own Postgres schema |

Database drivers are optional peers, loaded only when an adapter needs them: `neo4j-driver`,
`@qdrant/js-client-rest`. `pg` is installed with the package.

ES modules only.
