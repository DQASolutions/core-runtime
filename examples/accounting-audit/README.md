# Dogfood example — accounting / audit

A standalone consumer app that imports the **published `@dqa-ai-solutions/ontology-sdk`
surface** and drives it the way a real downstream user would. It models a small
accounting-audit domain and runs the full SDK lifecycle against the in-memory
adapter, then asserts the audit rules fire as expected.

Its job is to **dogfood the public API**: if any capability regresses, this run
either prints different output or throws — making it a fast, dependency-free
acceptance check that complements the unit suite.

## The domain

| Concept | Entity / edge | Notes |
|---|---|---|
| Ledger account | `Account` { code, name } | chart-of-accounts node |
| Voucher | `Voucher` { docNo, amount, issuedOn, status } | the accounting document |
| Evidence | `Evidence` { kind, ref } | invoice / receipt / contract |
| Posting | `posts_to` (Voucher → Account, `1..N`) | one account per voucher |
| Substantiation | `supported_by` (Voucher → Evidence, `N..N`) | a voucher's proof |

Three audit **rules** (data, not code — their `condition` describes the
*violation*):

- `R-EVIDENCE-REQUIRED` — a voucher with **no** `supported_by` edge.
- `R-VOUCHER-MUST-POST` — a voucher with **no** `posts_to` edge.
- `R-HIGHVALUE-DUAL-EVIDENCE` — `amount >= 10,000,000` **and** fewer than 2 evidences.

> Rule relationship-ops (`exists`/`absent`/`count`) inspect a node's **outgoing**
> edges, so both relationships originate at `Voucher` — that's why the rule
> subject is always the `from` side.

## What it exercises

| Section | SDK calls |
|---|---|
| 1. Schema | `defineEntityType` · `defineRelationshipType` · `migrate` · `getSchema` |
| 2. Data | `create` (with mandatory provenance) |
| 3. Graph | `link` (+ cardinality-violation guard) |
| 4. Mutate | `update` · `get` |
| 5. Query | `find` in all three read modes — **read-all** (`where=undefined`), **property filter**, and **graph-aware** (relationship ops `absent`/`exists`/`count`) |
| 6. Walk | `neighbors` · `traverse` |
| 7. Rules | `registerRule` · `listRules` · `evaluateRules` |
| 8. Context | `context` (structural neighbourhood) |
| 9. Validation | negative cases — every malformed node/edge write must be **rejected** |
| 10. Backend parity | `FilesystemAdapter` — persist with one `Ontology`, read back through a fresh one; assert disk-backed reads/rules match the in-memory backend |
| 11. Backend parity | `PostgresAdapter` (opt-in) — same scenario over real SQL with schema-per-tenant isolation; asserts reads/rules/cardinality match. Skips cleanly if no DB is reachable |

### Input validation (section 9)

The SDK validates writes *before* they reach storage, and section 9 asserts it
by firing 10 deliberately-bad writes — each must throw the expected error code:

| Probe | Error code |
|---|---|
| node: unknown property | `UNKNOWN_PROPERTY` |
| node: type mismatch (`amount` as string) | `TYPE_MISMATCH` |
| node: invalid enum value | `ENUM_VALUE_INVALID` |
| node: missing required property | `REQUIRED_PROPERTY_MISSING` |
| node: re-declared provenance field | `PROVENANCE_FIELD_REDECLARED` |
| node: unknown entity type | `UNKNOWN_ENTITY_TYPE` |
| write: missing provenance | `PROVENANCE_MISSING` |
| edge: endpoint type mismatch | `ENDPOINT_TYPE_MISMATCH` |
| edge: endpoint instance not found | `INSTANCE_NOT_FOUND` |
| edge: unknown relationship type | `UNKNOWN_RELATIONSHIP_TYPE` |

> Note on edges: an `Edge` carries no property bag (`relationship + fromId +
> toId + provenance` only), so edge "input validation" means **endpoint typing +
> cardinality + provenance** — there are no free-form edge attributes to type-check.
> Node validation lives in `core/graph/validation.ts`; edge validation in `link()`.

## Run it

From the repo root:

```bash
npm run example:accounting
# or directly (Node >= 22.6 strips the TypeScript types natively):
node examples/accounting-audit/main.ts
```

**Section 11 (Postgres) is opt-in.** It runs against a reachable Postgres and is
skipped otherwise — the run still passes. It defaults to the project's docker DB
(`postgres://ontology:ontology@localhost:5433/ontology`); override with
`DATABASE_URL`. It creates an isolated `t_dogfood_pg` schema and drops it before
and after, so it never touches your other data:

```bash
DATABASE_URL=postgres://user:pass@host:5432/db npm run example:accounting
```

Expected tail:

```
flags by rule: {"R-EVIDENCE-REQUIRED":1,"R-HIGHVALUE-DUAL-EVIDENCE":1}
reads: find-all/property/graph-aware OK
validation: 10/10 bad writes rejected
filesystem parity + durability: OK
postgres parity: OK
✓ dogfood run passed — SDK behaved as expected across all capabilities (in-memory + filesystem + postgres)
```

> **Sharp edge — schema is not rehydrated from disk.** The `FilesystemAdapter`
> persists `_schema.json`, but the `Ontology` façade keeps entity/relationship
> definitions in an in-memory, per-tenant registry and never reads that file
> back. A fresh `Ontology` (new process, or a different tenant) must
> re-`defineEntityType`/`defineRelationshipType` *before* it can `find`/`create`
> against existing data — otherwise it throws `UNKNOWN_ENTITY_TYPE`. Section 10's
> `declareSchema()` helper makes that requirement explicit.

> **Reads import the *built* `dist/`, not `src/`.** This example surfaced a stale
> `dist/` where graph-aware `find()` (relationship ops) threw `UNSUPPORTED_OP`
> even though `src/` supported it (FR-X04). `npm run build` resyncs them. Running
> the dogfood after a build guards against the published surface drifting from source.

The process exits non-zero if the rule evaluation doesn't match expectations, so
it can gate CI.

## Files

- `ontology.ts` — the domain as pure data (entity types, relationship types, rules).
- `main.ts` — wires `createOntology({ adapter: new InMemoryAdapter() })` and drives the lifecycle.
