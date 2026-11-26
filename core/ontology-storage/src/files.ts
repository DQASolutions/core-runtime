// The kernel's FILE translation layer — the exact counterpart of `storage.ts`,
// one layer over. An app DECLARES where its files live (in app.yaml); the
// kernel MAPS that declaration to a concrete FileStore here.
//
// Same split of responsibility, and for the same reason (do not collapse these):
//   • app.yaml — the app author commits WHICH adapter (filesystem | s3).
//   • env      — the deployment supplies the SECRETS (endpoint, keys). Never in
//                the app file, so one app runs against dev/stg/prod unchanged.
//   • this file — the kernel reads the name + reads the env, builds the class.
//
// WHY FILES ARE DECLARED SEPARATELY FROM STORAGE
//
// They are different axes and apps really do mix them. An edge node runs
// `storage: postgres` (it needs transactions) with `files: filesystem` (it is
// one box, offline). A central deployment runs the same `storage: postgres`
// with `files: s3`, because two processes cannot share a directory. Folding
// files into StorageSpec would force those two choices to move together, and
// they don't.
//
// An app that declares no `files:` gets a directory under the workspace — the
// same "works with zero configuration" default `storage:` gives.

import path from 'node:path'
import { LocalFileStore, S3FileStore, type FileStore } from '@dqa-ai-solutions/ontology-sdk'

export type FileStoreKind = 'filesystem' | 's3'

export interface FileSpec {
  /** Where files live. Default: `filesystem`. */
  adapter?: FileStoreKind
  /** filesystem only — root dir. Relative paths resolve under the workspace.
   *  Default: `.dqa/files`. */
  path?: string
  /** s3 only — bucket name. Committed in the app file because it is a NAME, not
   *  a secret, and the app's files must not scatter across buckets per
   *  environment. Default: `dqa-files`. */
  bucket?: string
  /** s3 only — name of the env var holding the endpoint URL.
   *  Default: `S3_ENDPOINT`. The value lives in the environment, never here. */
  endpointEnv?: string
  /** s3 only — name of the env var holding the access key. Default: `S3_ACCESS_KEY`. */
  accessKeyEnv?: string
  /** s3 only — name of the env var holding the secret key. Default: `S3_SECRET_KEY`. */
  secretKeyEnv?: string
  /** s3 only — signing region. Ignored by MinIO, but signed either way. */
  region?: string
}

/** Read a required env var, naming the app-file field that asked for it. */
function requireEnv(envName: string, field: string): string {
  const value = process.env[envName]
  if (!value) {
    throw new Error(
      `app.yaml files.adapter=s3 needs ${field} in env ${envName} ` +
        `(it is intentionally not stored in the app — set ${envName} in the deployment environment)`,
    )
  }
  return value
}

/**
 * Map a declarative file spec → a concrete FileStore. Defaults to a directory
 * so an app without a manifest behaves exactly as before. Secrets come from
 * the environment.
 *
 * ⚠️ NO SILENT FALLBACK. An app that declares `s3` and cannot reach it fails at
 *    boot rather than writing to a local directory instead. Falling back means
 *    signed documents land inside a container nobody is backing up, and nobody
 *    finds out until the container is rebuilt — at which point they are gone.
 */
export function buildFileStore(spec: FileSpec | undefined, loc: { workspace: string }): FileStore {
  const kind = spec?.adapter ?? 'filesystem'
  switch (kind) {
    case 'filesystem': {
      const rel = spec?.path ?? path.join('.dqa', 'files')
      const root = path.isAbsolute(rel) ? rel : path.join(loc.workspace, rel)
      return new LocalFileStore({ root })
    }

    case 's3':
      return new S3FileStore({
        endpoint: requireEnv(spec?.endpointEnv ?? 'S3_ENDPOINT', 'the endpoint'),
        bucket: spec?.bucket ?? 'dqa-files',
        accessKey: requireEnv(spec?.accessKeyEnv ?? 'S3_ACCESS_KEY', 'the access key'),
        secretKey: requireEnv(spec?.secretKeyEnv ?? 'S3_SECRET_KEY', 'the secret key'),
        ...(spec?.region ? { region: spec.region } : {}),
      })

    default:
      throw new Error(`app.yaml files.adapter: unknown adapter "${String(kind)}" (use filesystem | s3)`)
  }
}
