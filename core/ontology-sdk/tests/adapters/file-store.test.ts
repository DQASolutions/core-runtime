// FileStore parity suite. The SAME cases run against every adapter, because the
// port's whole promise is that a caller cannot tell which one it holds — and
// two implementations that quietly disagree only reveal it on the day you
// switch backends, which is the worst day to find out.
//
// LocalFileStore always runs (a temp dir). S3FileStore joins when a live store
// is configured, same convention as the Neo4j smoke test:
//
//   docker run -p9000:9000 -e MINIO_ROOT_USER=minioadmin \
//     -e MINIO_ROOT_PASSWORD=minioadmin minio/minio server /data
//   S3_ENDPOINT=http://localhost:9000 S3_ACCESS_KEY=minioadmin \
//     S3_SECRET_KEY=minioadmin npm test --workspace @dqa-ai-solutions/ontology-sdk -- file-store

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalFileStore, S3FileStore, FileKeyError, assertFileKey } from '../../src/index.js'
import type { FileStore } from '../../src/index.js'

const S3_LIVE = Boolean(process.env['S3_ENDPOINT'])

// A key with a non-ASCII document number and the five characters
// `encodeURIComponent` leaves alone — the exact shape that broke signing.
const AWKWARD_KEY = "decisions/15-QĐ-UBND (bản chính)!'*.png"

const cases: Array<[string, () => Promise<{ store: FileStore; cleanup: () => Promise<void> }>]> = [
  [
    'LocalFileStore',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'file-store-'))
      return { store: new LocalFileStore({ root }), cleanup: () => rm(root, { recursive: true, force: true }) }
    },
  ],
  ...(S3_LIVE
    ? ([
        [
          'S3FileStore',
          async () => ({
            store: new S3FileStore({
              endpoint: process.env['S3_ENDPOINT']!,
              // Fresh bucket per run so a rerun never reads last run's bytes.
              bucket: `file-store-test-${Date.now()}`,
              accessKey: process.env['S3_ACCESS_KEY']!,
              secretKey: process.env['S3_SECRET_KEY']!,
            }),
            cleanup: async () => {},
          }),
        ],
      ] as typeof cases)
    : []),
]

describe.each(cases)('%s — FileStore contract', (_name, build) => {
  let store: FileStore
  let cleanup: () => Promise<void>
  beforeAll(async () => ({ store, cleanup } = await build()))
  afterAll(() => cleanup())

  it('put → get returns the same bytes', async () => {
    const bytes = Buffer.from('quyết định đã ký', 'utf8')
    const { ref } = await store.put('decisions/a.txt', bytes)
    expect(ref).toBe('decisions/a.txt')
    expect(await store.get(ref)).toEqual(bytes)
  })

  it('round-trips binary without corruption', async () => {
    // Every byte value 0–255: catches a store that treats bytes as UTF-8.
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i))
    const { ref } = await store.put('scans/all-bytes.bin', bytes)
    expect(await store.get(ref)).toEqual(bytes)
  })

  it('handles non-ASCII keys and S3-reserved characters', async () => {
    const bytes = Buffer.from('ảnh bản gốc')
    const { ref } = await store.put(AWKWARD_KEY, bytes)
    expect(await store.get(ref)).toEqual(bytes)
    expect(await store.exists(ref)).toBe(true)
  })

  it('put overwrites rather than erroring or appending', async () => {
    await store.put('decisions/b.txt', Buffer.from('first'))
    await store.put('decisions/b.txt', Buffer.from('second'))
    expect((await store.get('decisions/b.txt')).toString()).toBe('second')
  })

  it('exists answers false for an absent ref, and never throws', async () => {
    expect(await store.exists('decisions/never-written.png')).toBe(false)
    // The port forbids throwing here even for a key that violates the contract.
    await expect(store.exists('../../etc/passwd')).resolves.toBe(false)
  })

  it('get throws for an absent ref', async () => {
    await expect(store.get('decisions/never-written.png')).rejects.toThrow()
  })

  it('rejects keys that escape the store', async () => {
    for (const bad of ['../escape.png', 'a/../../b.png', '/absolute.png', 'a//b.png', '']) {
      await expect(store.put(bad, Buffer.from('x'))).rejects.toThrow()
    }
  })
})

describe('assertFileKey', () => {
  it('accepts ordinary and non-ASCII keys', () => {
    expect(assertFileKey('decisions/12-QĐ-UBND.png')).toBe('decisions/12-QĐ-UBND.png')
    expect(assertFileKey('a')).toBe('a')
  })

  it('rejects the escape shapes', () => {
    for (const bad of ['', '/a', 'a//b', 'a/../b', './a', 'a/.', 'a\0b']) {
      expect(() => assertFileKey(bad)).toThrow(FileKeyError)
    }
  })
})

// The signature is the part that fails silently — a 403 with an empty body. Pin
// the three encoding rules here so a refactor cannot quietly break them without
// a live server present.
describe('S3FileStore — request signing', () => {
  const capture = async (key: string) => {
    const original = globalThis.fetch
    let url = ''
    let headers: Record<string, string> = {}
    globalThis.fetch = (async (u: string, init: RequestInit) => {
      url = String(u)
      headers = init.headers as Record<string, string>
      return new Response(null, { status: 200 })
    }) as typeof fetch
    try {
      const store = new S3FileStore({
        endpoint: 'http://minio:9000',
        bucket: 'van-ban',
        accessKey: 'AKIA_TEST',
        secretKey: 'secret_test',
      })
      // `exists` is the one operation that skips the bucket check, so a single
      // signed request lands in the capture.
      await store.exists(key)
    } finally {
      globalThis.fetch = original
    }
    return { url, headers }
  }

  it('keeps `/` unencoded and percent-encodes UTF-8 and S3-reserved chars', async () => {
    const { url } = await capture(AWKWARD_KEY)
    expect(url.startsWith('http://minio:9000/van-ban/decisions/')).toBe(true)
    expect(url).toContain('15-Q%C4%90-UBND') // Đ → UTF-8 two bytes
    expect(url).toContain('%20') // space
    expect(url).toContain('%28') // (
    expect(url).toContain('%29') // )
    expect(url).toContain('%21') // !
    expect(url).toContain('%27') // '
    expect(url).toContain('%2A') // *
  })

  it('signs with SigV4 over the empty-payload hash', async () => {
    const { headers } = await capture('decisions/a.png')
    expect(headers['authorization']).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIA_TEST\/\d{8}\/us-east-1\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    )
    // SHA-256 of the empty string — the required value for a bodyless request.
    expect(headers['x-amz-content-sha256']).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
    expect(headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/)
  })

  it('refuses to construct without full configuration', () => {
    expect(() => new S3FileStore({ endpoint: 'http://minio:9000', bucket: '', accessKey: 'a', secretKey: 'b' }))
      .toThrow(/missing options: bucket/)
  })
})
