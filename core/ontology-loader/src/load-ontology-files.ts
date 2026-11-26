// Read an app's ontology from MANY YAML files — once per change, not once per call.
//
// Why this lives in the kernel: views, functions, rules and executors are all
// read from disk by kernel loaders, but the ontology was not — `loadOntology()`
// takes an already-parsed object. So every app wrote its own reader, merge,
// duplicate check and `resolveValueTypes`, and each copy drifted:
//   · one production app re-parsed 62 files (2.1 MB) on every request — 56% of API CPU;
//   · another cached forever, so an edited `ontology.yaml` was ignored until a
//     restart, and never resolved value types at all.
// One reader, one cache policy, here.
//
// CACHE POLICY: the key is the file list plus each file's mtime and size
// (a stat per file, well under a millisecond for dozens of files). Edit, add or
// remove a file and the next call reloads — no restart, no `--watch` needed.
// The result is DEEP-FROZEN: every caller shares one object, so a caller that
// mutates it fails on the spot instead of corrupting the next request's schema.
//
// DERIVED CACHES: anything an app builds from the result (a lookup by entity
// name, a label table) must rebuild when the ontology does. Key it on the
// returned object (a WeakMap — a reload returns a NEW object) or on `version`
// (a content hash), never on "computed once at first use".

import { readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import yaml from 'js-yaml'
import { resolveValueTypes, type EntityTypeDef, type RelationshipTypeDef, type ValueTypeDef } from '@dqa-ai-solutions/ontology-sdk'

/** One ontology file. `label` names it in error messages (default: the path). */
export interface OntologyFile {
  path: string
  label?: string
}

/** The raw, merged declaration — the shape of one `ontology.yaml` holding everything.
 *  Entities have `transformEntity` applied but value types NOT resolved: this is
 *  for checkers and generators that inspect the declaration itself. Top-level keys
 *  other than the three below are concatenated as arrays when they are arrays. */
export interface OntologyDoc {
  valueTypes: ValueTypeDef[]
  entities: EntityTypeDef[]
  relationships: RelationshipTypeDef[]
  [key: string]: unknown[]
}

export interface OntologyPack {
  /** Entities with value types resolved into their properties — ready for `defineEntityType`. */
  entities: EntityTypeDef[]
  relationships: RelationshipTypeDef[]
  valueTypes: ValueTypeDef[]
  /** The merged declaration before value-type resolution (see {@link OntologyDoc}). */
  doc: OntologyDoc
  /** Content hash of the files, in order. Changes iff the content does — key derived caches on it. */
  version: string
}

export interface LoadOntologyFilesOptions {
  /** Files in merge order. Order matters only for error labels and `doc` order. */
  files: Array<string | OntologyFile>
  /**
   * App-specific rewrite of each entity, applied before value types resolve
   * (e.g. adding ownership properties every scoped entity must carry). Cached
   * together with the parse, so it must be PURE: same entity in, same entity out.
   * Pass a stable function (module-level), not a fresh closure per call — the
   * cache treats a different function as a different load.
   */
  transformEntity?: (entity: EntityTypeDef) => EntityTypeDef
}

interface Entry {
  signature: string
  transform: LoadOntologyFilesOptions['transformEntity']
  pack: OntologyPack
}

const cache = new Map<string, Entry>()

/**
 * Read, merge and resolve an ontology spread over many YAML files, cached until
 * any of the files changes. Each file may declare `valueTypes`, `entities` and
 * `relationships` (and any other array keys, kept in `doc`).
 *
 * ⛔ The same entity or relationship name in two files is an ERROR, not a later
 *    file overriding an earlier one: the name is a system-wide key, so a silent
 *    override means two parts of the app write over each other's data.
 */
export function loadOntologyFiles(options: LoadOntologyFilesOptions): OntologyPack {
  const files = options.files.map((f) => (typeof f === 'string' ? { path: f } : f))
  const key = files.map((f) => f.path).join('\n')
  const signature = filesSignature(files.map((f) => f.path))
  const hit = cache.get(key)
  if (hit && hit.signature === signature && hit.transform === options.transformEntity) return hit.pack
  const pack = deepFreeze(parse(files, options.transformEntity))
  cache.set(key, { signature, transform: options.transformEntity, pack })
  return pack
}

/** Drop every cached load — for tests that rewrite files within the same mtime tick. */
export function clearOntologyFilesCache(): void {
  cache.clear()
}

function filesSignature(paths: string[]): string {
  return paths
    .map((p) => {
      const s = statSync(p)
      return `${p}@${s.mtimeMs}:${s.size}`
    })
    .join('|')
}

function parse(files: OntologyFile[], transform: LoadOntologyFilesOptions['transformEntity']): OntologyPack {
  const doc: OntologyDoc = { valueTypes: [], entities: [], relationships: [] }
  const seenEntity = new Map<string, string>()
  const seenRel = new Map<string, string>()
  const hash = createHash('sha256')

  for (const file of files) {
    const text = readFileSync(file.path, 'utf8')
    hash.update(file.path).update('\0').update(text).update('\0')
    const label = file.label ?? file.path
    const parsed = (yaml.load(text) ?? {}) as Record<string, unknown>
    if (typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Ontology file "${label}" must hold a mapping (valueTypes / entities / relationships)`)
    }
    for (const [k, v] of Object.entries(parsed)) {
      if (!Array.isArray(v)) continue
      if (k === 'entities') {
        for (const e of v as EntityTypeDef[]) {
          const first = seenEntity.get(e.name)
          if (first) throw new Error(`Entity "${e.name}" is declared in both "${first}" and "${label}" — an entity name is a system-wide key`)
          seenEntity.set(e.name, label)
          doc.entities.push(transform ? transform(e) : e)
        }
      } else if (k === 'relationships') {
        for (const r of v as RelationshipTypeDef[]) {
          const first = seenRel.get(r.name)
          if (first) throw new Error(`Relationship "${r.name}" is declared in both "${first}" and "${label}"`)
          seenRel.set(r.name, label)
          doc.relationships.push(r)
        }
      } else {
        ;(doc[k] ??= []).push(...v)
      }
    }
  }

  return {
    entities: resolveValueTypes(doc.entities, doc.valueTypes),
    relationships: doc.relationships,
    valueTypes: doc.valueTypes,
    doc,
    version: hash.digest('hex').slice(0, 16),
  }
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const v of Object.values(o)) deepFreeze(v)
  }
  return o
}
