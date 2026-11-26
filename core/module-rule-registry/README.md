# @dqa-ai-solutions/module-rule-registry

Rule governance for FieldOS: **scope** (firm/client) · **template** (mẫu tái dùng) · **versioning**
· **subscription** · `resolve(client, asOf) → merged rule-set + run manifest`.

Domain-agnostic and **fact-blind**: the registry only manipulates rule IR + scope; it never reads
facts or interprets a rule — evaluation is delegated to `@dqa-ai-solutions/ontology-rules` (the CHECK ENGINE).

## Status — M1 (spine)

- `src/types.ts` — core types (`ScopedRule`, `RuleOverride`, `ResolvedManifest`, layer precedence).
- `src/resolve.ts` — **pure** `resolveRuleSet()`: layer merge (later wins by `rule_id`) + overrides
  (disable/patch) → resolved rules + immutable, hashed manifest (lockfile). No DB, no fact access.
- `src/tenant-registry.ts` / `src/store.ts` — ports (pg adapter lands in M1 wiring).
- `migrations/001_rule_registry.sql` — control-plane schema (own `rule_registry` Postgres schema;
  no hard FK to app tables — tenants referenced by id, validated via port).

## Roadmap

M0 scaffold ✅ · M1 pure resolve + schema ✅ → pg store adapter + patch `loadRuleStore` + migrate
`app/rules/*.json` → base template (parity test) · M2 templates/compose · M3 channels/rollout · M4 UI.

## Dev

```
../../node_modules/.bin/vitest run    # unit tests (pure, no DB)
../../node_modules/.bin/tsc -p .      # build → dist/
```
