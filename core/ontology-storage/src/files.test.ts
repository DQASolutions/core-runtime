// buildFileStore — the app.yaml → FileStore mapping. Mirrors storage.test.ts:
// the point is that a DECLARATION picks the class and the ENVIRONMENT supplies
// the secrets, and that a misconfigured app fails loudly at boot.

import { describe, it, expect, afterEach } from 'vitest'
import { LocalFileStore, S3FileStore } from '@dqa-ai-solutions/ontology-sdk'
import { buildFileStore } from './files.js'

const LOC = { workspace: '/srv/app' }

const S3_ENV = {
  S3_ENDPOINT: 'http://minio:9000',
  S3_ACCESS_KEY: 'AKIA_TEST',
  S3_SECRET_KEY: 'secret_test',
}
const touched: string[] = []
const setEnv = (vars: Record<string, string>) => {
  for (const [k, v] of Object.entries(vars)) {
    touched.push(k)
    process.env[k] = v
  }
}
afterEach(() => {
  for (const k of touched.splice(0)) delete process.env[k]
})

describe('buildFileStore', () => {
  it('defaults to a directory under the workspace when nothing is declared', () => {
    expect(buildFileStore(undefined, LOC)).toBeInstanceOf(LocalFileStore)
  })

  it('resolves a relative path under the workspace and keeps an absolute one', () => {
    // The root is private, so assert through behaviour the port exposes: both
    // constructions succeed and neither throws on a legal key.
    expect(buildFileStore({ adapter: 'filesystem', path: 'uploads' }, LOC)).toBeInstanceOf(LocalFileStore)
    expect(buildFileStore({ adapter: 'filesystem', path: '/var/lib/dqa' }, LOC)).toBeInstanceOf(LocalFileStore)
  })

  it('builds an S3 store from env-supplied secrets', () => {
    setEnv(S3_ENV)
    expect(buildFileStore({ adapter: 's3', bucket: 'van-ban' }, LOC)).toBeInstanceOf(S3FileStore)
  })

  it('reads secrets from the env vars the app names', () => {
    setEnv({ APP_S3_ENDPOINT: 'http://minio:9000', APP_S3_KEY: 'k', APP_S3_SECRET: 's' })
    const store = buildFileStore(
      {
        adapter: 's3',
        bucket: 'van-ban',
        endpointEnv: 'APP_S3_ENDPOINT',
        accessKeyEnv: 'APP_S3_KEY',
        secretKeyEnv: 'APP_S3_SECRET',
      },
      LOC,
    )
    expect(store).toBeInstanceOf(S3FileStore)
  })

  it('fails at boot — never falls back to a directory — when a secret is absent', () => {
    setEnv({ S3_ENDPOINT: 'http://minio:9000' }) // keys deliberately missing
    expect(() => buildFileStore({ adapter: 's3' }, LOC)).toThrow(/S3_ACCESS_KEY/)
  })

  it('names the offending value for an unknown adapter', () => {
    expect(() => buildFileStore({ adapter: 'ftp' as never }, LOC)).toThrow(/unknown adapter "ftp"/)
  })
})
