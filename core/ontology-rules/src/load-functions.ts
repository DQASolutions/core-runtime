// Load an app's COMPILED functions modules and bind them into the ontology.
//
// Decision A: apps ship compiled `.js` (authors write `.ts`, `tsc` builds, the
// kernel `import()`s the `.js`) — no runtime TS loader, consistent with how the
// example apps already build. This imports every `<dir>/*.js`, collects the
// FnSpecs each module exports (`collectSpecs`), binds compute/action bodies via
// the SDK SPI (`defineFunctionImpl` / `defineActionImpl`, per `ctx` tenant), and
// returns the rules grouped by entity type for the `check` step.
//
// LAYERING (the overlay seam): `loadFunctions` accepts MANY dirs — a base layer
// plus optional overlays (e.g. an industry app). Dirs load in order; a later
// layer OVERRIDES an earlier one by rule `id` (and compute/action `name`). This
// is how an industry overlay ADDS rules or REPLACES a base rule without forking
// the base — no kernel/base change needed. (Disable a base rule = override it
// with a no-op predicate.) A single dir (string) is the back-compatible default.

import fs from 'fs-extra'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Ontology, Ctx } from '@dqa-ai-solutions/ontology-sdk'
import { collectSpecs, type CollectedSpecs, type RuleSpec } from './fn.js'
import { ruleFromIR, type RuleIR, type RuleRuntime } from './eval-expr.js'
import { assertRuleIRSchema } from './rule-schema.js'

/** Rules grouped by the entity type they apply to (the `check` sweep map). */
export type RulesByType = Record<string, RuleSpec[]>

/**
 * Collapse layered specs so a LATER layer wins: rules deduped by `id`,
 * computes/actions by `name`, keeping the last occurrence. (Base specs are
 * collected first, overlays last, so overlays override.) Pure — unit-testable
 * without disk; the override semantics live here, not in the import loop.
 */
export function overrideLast(c: CollectedSpecs): CollectedSpecs {
  const lastBy = <T>(arr: T[], key: (x: T) => string): T[] => [...new Map(arr.map((x) => [key(x), x])).values()]
  const rulesByType: RulesByType = {}
  for (const [t, rs] of Object.entries(c.rulesByType)) rulesByType[t] = lastBy(rs, (r) => r.id)
  return { computes: lastBy(c.computes, (x) => x.name), actions: lastBy(c.actions, (x) => x.name), rulesByType }
}

/**
 * Import + bind an app's functions across one or more layer dirs. Returns the
 * rules-by-type map (empty when no dir exists). Compute/Action bodies are bound
 * into `ontology` for `ctx.tenantId`; rules are returned (the kernel sweeps them
 * in the check step). Later dirs override earlier by id/name (see file header).
 */
export async function loadFunctions(ontology: Ontology, functionsDirs: string | string[], ctx: Ctx): Promise<RulesByType> {
  const dirs = Array.isArray(functionsDirs) ? functionsDirs : [functionsDirs]
  const collected: CollectedSpecs = { computes: [], actions: [], rulesByType: {} }
  for (const dir of dirs) {
    if (!(await fs.pathExists(dir))) continue
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.js')).sort()
    for (const f of files) {
      const mod = (await import(pathToFileURL(path.join(dir, f)).href)) as Record<string, unknown>
      collectSpecs(mod, collected)
    }
  }
  const merged = overrideLast(collected)
  for (const c of merged.computes) {
    await ontology.defineFunctionImpl({ def: { name: c.name }, body: c.body }, ctx)
  }
  for (const a of merged.actions) {
    await ontology.defineActionImpl({ def: { name: a.name }, guard: a.guard, effect: a.effect }, ctx)
  }
  return merged.rulesByType
}

/**
 * Runtime LOAD+BUILD path for rules-as-DATA. Reads a directory (or layers) of
 * JSON rule files — each a {@link RuleIR} or an array of them — compiles each via
 * `ruleFromIR`, and groups them by entity type for the `check` sweep. This is what
 * makes a persisted JSON rule store (rules a user authored + an expert approved)
 * actually RUN: no TypeScript per rule, same sweep as `functions/*.js` rules.
 *
 * Only `active` rules run — a rule with `status` set to anything other than
 * 'active' (draft/pending-review/deprecated) is skipped, so the same store can
 * hold in-flight drafts. Later dirs override earlier by `id` (overlay semantics).
 * `computes` (optional) exposes named macros to `call` nodes.
 */
export async function loadRuleStore(ruleDirs: string | string[], rt: RuleRuntime = {}): Promise<RulesByType> {
  const dirs = Array.isArray(ruleDirs) ? ruleDirs : [ruleDirs]
  const specs: RuleSpec[] = []
  for (const dir of dirs) {
    if (!(await fs.pathExists(dir))) continue
    // `_`/`.`-prefixed files are meta (schema, notes) — not rules. Skip them.
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json') && !f.startsWith('_') && !f.startsWith('.')).sort()
    for (const f of files) {
      const raw = (await fs.readJson(path.join(dir, f))) as RuleIR | RuleIR[]
      const list = Array.isArray(raw) ? raw : [raw]
      // FIXED-schema gate FIRST — a malformed store fails loud at load with file
      // context, never silently dropping a rule or blowing up mid check-sweep.
      list.forEach((ir, i) => assertRuleIRSchema(ir, `${f}[${i}]${ir && typeof ir === 'object' && 'id' in ir ? ` id=${(ir as RuleIR).id}` : ''}`))
      for (const ir of list) {
        if (ir.status && ir.status !== 'active') continue
        specs.push(ruleFromIR(ir, rt))
      }
    }
  }
  return groupRulesByType(specs)
}

/** Group compiled specs by entity type, later-wins by `id` (the `check` sweep map).
 *  Pure — shared by the file loader and the in-memory (registry) loader. */
export function groupRulesByType(specs: RuleSpec[]): RulesByType {
  const lastBy = <T>(arr: T[], key: (x: T) => string): T[] => [...new Map(arr.map((x) => [key(x), x])).values()]
  const byType: RulesByType = {}
  for (const r of specs) (byType[r.on] ??= []).push(r)
  for (const t of Object.keys(byType)) byType[t] = lastBy(byType[t], (r) => r.id)
  return byType
}

/**
 * IN-MEMORY twin of {@link loadRuleStore}: compile an already-resolved list of
 * {@link RuleIR} (e.g. from `@dqa-ai-solutions/module-rule-registry` `resolveForClient`) into the check
 * sweep map — same schema gate, same active-only filter, same group/override-by-id.
 * This is the seam that lets the `check` step run RDB-sourced rules WITHOUT this
 * module depending on the registry: the wiring layer resolves rules and passes the
 * IRs in. `label` gives error context for the schema gate (default: index + id).
 */
export function rulesByTypeFromIR(
  irs: RuleIR[],
  rt: RuleRuntime = {},
  label: (ir: RuleIR, i: number) => string = (ir, i) =>
    `[${i}]${ir && typeof ir === 'object' && 'id' in ir ? ` id=${(ir as RuleIR).id}` : ''}`,
): RulesByType {
  const specs: RuleSpec[] = []
  irs.forEach((ir, i) => {
    // FIXED-schema gate FIRST — malformed IR fails loud, never silently dropped.
    assertRuleIRSchema(ir, label(ir, i))
    if (ir.status && ir.status !== 'active') return
    specs.push(ruleFromIR(ir, rt))
  })
  return groupRulesByType(specs)
}

/** Merge rule maps (e.g. function rules + IR-store rules) into one sweep map.
 *  Later maps override earlier by rule id within each type. */
export function mergeRulesByType(...maps: RulesByType[]): RulesByType {
  const lastBy = <T>(arr: T[], key: (x: T) => string): T[] => [...new Map(arr.map((x) => [key(x), x])).values()]
  const out: RulesByType = {}
  for (const m of maps) for (const [t, rs] of Object.entries(m)) out[t] = [...(out[t] ?? []), ...rs]
  for (const t of Object.keys(out)) out[t] = lastBy(out[t], (r) => r.id)
  return out
}
