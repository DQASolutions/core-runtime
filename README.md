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

## This repository

The source of `@dqa-ai-solutions/core-runtime`. One package is published; the others are its parts and are bundled into it.

| Folder | | |
|---|---|---|
| `core/core-runtime` | **published** | The core tier in one package: ontology SDK, rule language, pack loaders, storage builders, governance, rule registry |
| `core/module-rule-registry` | inside | Rule governance: scope (firm/client) + template + versioning + subscription; resolve(client, asOf) → merged rule-set + run manifest |
| `core/ontology-base` | inside | Ontology declarations only, no dependencies: value types, entity and relationship types, shared concepts, behaviour signatures — plus the ontology file format (JSON Schema, in JSON and YAML) and language-neutral conformance cases. |
| `core/ontology-governance` | inside | Governance binding over @dqa-ai-solutions/ontology-sdk: an interceptor chain (RBAC · audit · provenance) wrapping the single write door (applyAction). |
| `core/ontology-loader` | inside | Ontology pack loaders: ontology.yaml / rules.yaml declarations → Ontology Port registrations, and the multi-file ontology loader |
| `core/ontology-rules` | inside | The rule language: core operations, rules-as-data interpreter (eval-expr), rule schema, fn/rule/action specs, function loader, rule and ontology validation. |
| `core/ontology-sdk` | inside | Backend-agnostic TypeScript ontology SDK — entity / relationship / rule / traversal / provenance over a StorageAdapter |
| `core/ontology-storage` | inside | Storage and file-store builders from an app manifest (memory · filesystem · postgres · neo4j; local · s3). |

Examples, each installing only published names: `examples/accounting-audit`.

Companion repositories: [app-runtime](https://github.com/DQASolutions/app-runtime) · [agent-runtime](https://github.com/DQASolutions/agent-runtime).

## Build from source

```sh
npm install
npm run build
npm test
npm run lint
```

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
