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

## This repository

The source of `@dqa-ai-solutions/core-runtime`. One package is published; the others are its parts and are bundled into it.

| Folder | | |
|---|---|---|
| `core/core-runtime` | **published** | The shared core, pure and the same on every side: ontology concepts and declarations, value checks, the rule language and its interpreter, the schema surface, the view contract |
| `core/ontology-base` | inside | Ontology declarations only, no dependencies: value types, entity and relationship types, shared concepts, behaviour signatures — plus the ontology file format (JSON Schema, in JSON and YAML) and language-neutral conformance cases. |
| `core/ontology-model` | inside | The shared, pure part of the ontology: concepts, value checks, the rule and condition interpreter, the schema surface, and the ports a backend implements |
| `core/ontology-rules` | inside | The rule language: core operations, rules-as-data interpreter (eval-expr), rule schema, fn/rule/action specs, function loader, rule and ontology validation. |
| `core/view-contract` | inside | What an app declares about a screen and the flat ViewContract a renderer receives — types and vocabulary shared by the server that resolves it and every renderer that draws it. |

Companion repositories: [ontology-runtime](https://github.com/DQASolutions/ontology-runtime) · [app-runtime](https://github.com/DQASolutions/app-runtime) · [ui-runtime](https://github.com/DQASolutions/ui-runtime) · [agent-runtime](https://github.com/DQASolutions/agent-runtime).

## Build from source

```sh
npm install
npm run build
npm test
npm run lint
```

## License

Apache License 2.0 — see [LICENSE](LICENSE) and [NOTICE](NOTICE).
