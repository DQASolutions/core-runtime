// The kernel's storage translation layer. An app DECLARES which backend it runs
// on (in app.yaml); the kernel MAPS that declaration to a concrete
// StorageAdapter here. This is the boundary that keeps storage a choice of the
// *app/deployment*, not something hardcoded in the runtime.
//
// Split of responsibility (do not collapse these):
//   • app.yaml  — the app author commits WHICH adapter (filesystem|postgres|memory).
//   • env        — the deployment supplies the SECRET (connection string). Never
//                  in the app file, so the same app runs against dev/stg/prod.
//   • this file  — the kernel reads the name + reads the env, builds the class.
//
// The ontology re-scopes the adapter to the tenant on every op
// (`adapter.withTenant(ctx.tenant)`), so the factory only has to point the
// adapter at the right *location* (a dir / a pool); tenant isolation is handled
// above it.

import path from 'node:path'
import {
  InMemoryAdapter,
  FilesystemAdapter,
  PostgresAdapter,
  Neo4jAdapter,
  type StorageAdapter,
} from '@dqa-ai-solutions/ontology-sdk'

export type StorageKind = 'filesystem' | 'postgres' | 'neo4j' | 'memory'

export interface StorageSpec {
  /** Backend to run on. Default: `filesystem`. */
  adapter?: StorageKind
  /** filesystem only — ontology dir. Relative paths resolve under the workspace.
   *  Default: `.dqa/ontology`. */
  path?: string
  /** postgres only — name of the env var holding the connection string.
   *  Default: `DATABASE_URL`. The value lives in the environment, never here. */
  connectionEnv?: string
}

/** An app's manifest (app.yaml). Storage is its first field; install/version
 *  metadata grows here later (roadmap M4). All fields optional → an app with no
 *  manifest runs on the filesystem default, unchanged. */
export interface AppManifest {
  name?: string
  storage?: StorageSpec
  /** Where the app's FILES live — a separate axis from `storage` (an edge node
   *  runs postgres + filesystem; central runs postgres + s3). See `files.ts`.
   *  Typed as the FileSpec that module owns; declared here because app.yaml is
   *  one document. Default: a directory under the workspace. */
  files?: import('./files.js').FileSpec
  /** Industry overlays to layer over the base `functions/` (override-by-id). Each
   *  name `<n>` loads `app/overlays/<n>/functions/*.js` AFTER the base, so it can
   *  add or replace base rules without forking the base. Default: none. */
  overlays?: string[]
  /** The app's default profile/mode — a domain-neutral string the app's own
   *  executors interpret (the accounting app maps it to `profiles/<profile>.yaml`,
   *  e.g. `tt200` | `tt133`). Threaded into every StepContext as the single source
   *  of truth; a step's `with.profile` still overrides it. Default: none. */
  profile?: string
  /** Review/as-of date (YYYY-MM-DD) for resolving effective-dated `param` thresholds
   *  from `law-parameters.json`. Overridden by an explicit `FieldApp.load({ asOf })`. */
  asOf?: string
}

export interface BuiltStorage {
  adapter: StorageAdapter
  /** Whether the backend needs schema provisioning (`ontology.migrate`) before
   *  writes. true for postgres (tables must exist); false for the schemaless
   *  filesystem / in-memory backends. */
  provision: boolean
}

/**
 * Map a declarative storage spec → a concrete StorageAdapter (+ whether it needs
 * provisioning). Defaults to the filesystem adapter so an app without a manifest
 * behaves exactly as before. Connection secrets are read from the environment.
 */
export function buildStorage(
  spec: StorageSpec | undefined,
  loc: { workspace: string; tenant: string },
): BuiltStorage {
  const kind = spec?.adapter ?? 'filesystem'
  switch (kind) {
    case 'memory':
      // Ephemeral, single-process — for tests / throwaway runs only.
      return { adapter: new InMemoryAdapter(undefined, loc.tenant), provision: false }

    case 'filesystem': {
      const rel = spec?.path ?? path.join('.dqa', 'ontology')
      const base = path.isAbsolute(rel) ? rel : path.join(loc.workspace, rel)
      return { adapter: new FilesystemAdapter(base, loc.tenant), provision: false }
    }

    case 'postgres': {
      const envName = spec?.connectionEnv ?? 'DATABASE_URL'
      const connectionString = process.env[envName]
      if (!connectionString) {
        throw new Error(
          `app.yaml storage.adapter=postgres needs the connection string in env ${envName} ` +
            `(it is intentionally not stored in the app — set ${envName} in the deployment environment)`,
        )
      }
      // Tenant → schema is applied per-op by the ontology; just hand it the pool.
      return { adapter: new PostgresAdapter({ connectionString }), provision: true }
    }

    case 'neo4j': {
      // Graph backend. Connection comes from env (NEO4J_URL / NEO4J_USER /
      // NEO4J_PASSWORD), read by the adapter — never from the app file.
      // provision:true so migrate() creates the id constraints on first use.
      return { adapter: new Neo4jAdapter(), provision: true }
    }

    default:
      throw new Error(
        `app.yaml storage.adapter: unknown adapter "${String(kind)}" (use filesystem | postgres | memory)`,
      )
  }
}
