// Declarative app loaders — turn an app's ontology/rules DECLARATIONS (parsed
// from YAML/JSON) into kernel registrations through the Ontology Port. This is
// what lets an app ship data, not code: the loader does the `defineType` /
// `registerRule` calls, not the app.

import type { OntologyPort, Ctx, EntityTypeDef, RelationshipTypeDef, RuleDef } from '@dqa-ai-solutions/ontology-sdk'

/** The shape of an `ontology.yaml` declaration. */
export interface OntologyDecl {
  entities?: EntityTypeDef[]
  relationships?: RelationshipTypeDef[]
}

/** The shape of a `rules.yaml` declaration — boilerplate (provenance, enabled,
 *  version) is optional and filled by the loader. */
export type RuleDecl = Pick<RuleDef, 'id' | 'kind' | 'appliesTo' | 'condition' | 'message'> & Partial<RuleDef>

export interface RulesDecl {
  rules?: RuleDecl[]
}

export interface RuleDefaults {
  source_ref?: string
  confirmed_by?: string
  confirmed_at?: string
  severity?: string
  /** Skip a rule already registered (install-if-absent) — for re-installs over
   *  a persistent store (e.g. a resumable session). */
  skipExisting?: boolean
}

/** Register the ontology types declared in an `ontology.yaml`. */
export async function loadOntology(port: OntologyPort, decl: OntologyDecl, ctx: Ctx): Promise<void> {
  for (const e of decl.entities ?? []) await port.defineEntityType(e, ctx)
  for (const r of decl.relationships ?? []) await port.defineRelationshipType(r, ctx)
}

/** Register the rules declared in a `rules.yaml`, filling NT4 boilerplate. */
export async function loadRules(port: OntologyPort, decl: RulesDecl, ctx: Ctx, defaults: RuleDefaults = {}): Promise<void> {
  const at = defaults.confirmed_at ?? '2026-01-01T00:00:00.000Z'
  for (const r of decl.rules ?? []) {
    const rule: RuleDef = {
      name: r.name ?? r.id,
      severity: r.severity ?? defaults.severity ?? 'REVIEW',
      source_ref: r.source_ref ?? defaults.source_ref ?? 'app',
      confirmed_by: r.confirmed_by ?? defaults.confirmed_by ?? 'app',
      confirmed_at: r.confirmed_at ?? at,
      enabled: r.enabled ?? true,
      version: r.version ?? 1,
      ...r,
    } as RuleDef
    try {
      await port.registerRule(rule, ctx)
    } catch (err) {
      const code = (err as { code?: string }).code ?? ''
      if (defaults.skipExisting && code.startsWith('DUPLICATE')) continue
      throw err
    }
  }
}
