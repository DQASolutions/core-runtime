// S3FileStore — the FileStore port over any S3-compatible object store: MinIO,
// Ceph RGW, AWS S3, or whatever an operator already runs. The multi-node
// answer, and the reason the port exists at all: two processes cannot share a
// directory, but they can share a bucket.
//
// ═══════════════════════════════════════════════════════════════════════════
// NO CLIENT LIBRARY — SigV4 IS SIGNED HERE, WITH `node:crypto`
//
// `@aws-sdk/client-s3` pulls 80+ packages; `minio` pulls 20+. This SDK ships
// with two dependencies and puts every backend client in `peerDependencies`
// (qdrant, neo4j) precisely so a consumer pays only for what it uses.
//
// SigV4 is four chained HMAC-SHA256 rounds over a canonical string. `node:crypto`
// does that and `fetch` is global from Node 18, so this adapter needs NEITHER a
// dependency NOR a peer — strictly cheaper than the pattern it follows.
//
// ⚠️ A wrong signature returns 403 with a body that does not say why. Three
//    traps, recorded so nobody re-derives them:
//      • The path must be percent-encoded IDENTICALLY in the request line and
//        in the canonical request. Keys carry non-ASCII document numbers
//        (`15-QĐ-UBND-….png`), so this is a real case, not a theoretical one.
//      • `encodeURIComponent` leaves `!'()*` alone; S3 requires them encoded.
//      • The `/` between segments must NOT be encoded — encoding it addresses a
//        different object, and the store will cheerfully create it.
//
// PATH-STYLE ADDRESSING, always. Virtual-host style (`bucket.host`) needs a
// wildcard DNS record, which an internally-deployed MinIO does not have.
// ═══════════════════════════════════════════════════════════════════════════

import { createHash, createHmac } from 'node:crypto'
import { assertFileKey, type FileStore } from '../../ports/file-store.js'

export interface S3FileStoreOptions {
  /** Base URL of the store, e.g. `http://minio:9000`. */
  endpoint: string
  /** Bucket that holds every file. Created on first write if absent. */
  bucket: string
  accessKey: string
  secretKey: string
  /** Signed into every request. MinIO ignores the value but the signature does not. */
  region?: string
}

const ALGORITHM = 'AWS4-HMAC-SHA256'
const sha256Hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string): Buffer => createHmac('sha256', key).update(data).digest()

/** Percent-encode one path segment the way S3 wants it. */
const encodeSegment = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

/** Encode a full path — every segment, never the separators. */
const encodePath = (path: string): string => path.split('/').map(encodeSegment).join('/')

export class S3FileStore implements FileStore {
  private readonly base: string
  private readonly host: string
  private readonly bucket: string
  private readonly accessKey: string
  private readonly secretKey: string
  private readonly region: string
  /** Bucket-exists check, run at most once per process — see `ensureBucket`. */
  private ready: Promise<void> | null = null

  constructor(opts: S3FileStoreOptions) {
    const missing = (['endpoint', 'bucket', 'accessKey', 'secretKey'] as const).filter((k) => !opts[k])
    if (missing.length) throw new Error(`S3FileStore is missing options: ${missing.join(', ')}`)
    this.base = opts.endpoint.replace(/\/+$/, '')
    this.host = new URL(this.base).host
    this.bucket = opts.bucket
    this.accessKey = opts.accessKey
    this.secretKey = opts.secretKey
    this.region = opts.region ?? 'us-east-1'
  }

  /** Sign a request with AWS SigV4 and send it. */
  private async send(method: string, path: string, body?: Buffer): Promise<Response> {
    const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '') // 20260819T101530Z
    const dateStamp = amzDate.slice(0, 8)
    const scope = `${dateStamp}/${this.region}/s3/aws4_request`
    const payloadHash = sha256Hex(body ?? '')

    // Minimum headers S3 signs. They must appear here in lowercase a→z order.
    const canonicalHeaders =
      `host:${this.host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n`
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'

    const canonicalRequest = [
      method,
      encodePath(path),
      '', // no query string on any of the three port operations
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n')

    const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n')

    // Signing key: derived per day / region / service, never the raw secret.
    const kDate = hmac(`AWS4${this.secretKey}`, dateStamp)
    const kRegion = hmac(kDate, this.region)
    const kService = hmac(kRegion, 's3')
    const kSigning = hmac(kService, 'aws4_request')
    const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')

    return fetch(`${this.base}${encodePath(path)}`, {
      method,
      headers: {
        host: this.host,
        'x-amz-date': amzDate,
        'x-amz-content-sha256': payloadHash,
        authorization:
          `${ALGORITHM} Credential=${this.accessKey}/${scope}, ` +
          `SignedHeaders=${signedHeaders}, Signature=${signature}`,
        ...(body ? { 'content-length': String(body.byteLength) } : {}),
      },
      // Spread rather than `body: body ?? undefined` — the SDK compiles with
      // `exactOptionalPropertyTypes`, under which an explicit `undefined` is
      // not the same as an absent key.
      ...(body ? { body: new Uint8Array(body) } : {}),
    })
  }

  /**
   * Make sure the bucket exists, once per process.
   *
   * Held in a promise rather than a boolean so concurrent first writes await
   * the same check instead of racing three creates. Not re-checked afterwards:
   * a bucket does not disappear, and paying a round-trip per upload to ask
   * would be a real cost for an imagined case.
   */
  private ensureBucket(): Promise<void> {
    return (this.ready ??= (async () => {
      const head = await this.send('HEAD', `/${this.bucket}`)
      if (head.ok) return
      if (head.status !== 404) {
        throw new Error(`Object store cannot report on bucket "${this.bucket}": HTTP ${head.status}`)
      }
      const created = await this.send('PUT', `/${this.bucket}`)
      // 409 = someone created it a beat earlier. Still the desired end state.
      if (!created.ok && created.status !== 409) {
        throw new Error(`Cannot create bucket "${this.bucket}": HTTP ${created.status}`)
      }
    })())
  }

  async put(key: string, bytes: Buffer | Uint8Array): Promise<{ ref: string }> {
    const k = assertFileKey(key)
    await this.ensureBucket()
    const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    const res = await this.send('PUT', `/${this.bucket}/${k}`, body)
    if (!res.ok) throw new Error(`Cannot store file "${k}": HTTP ${res.status}`)
    return { ref: k }
  }

  async get(ref: string): Promise<Buffer> {
    const k = assertFileKey(ref)
    const res = await this.send('GET', `/${this.bucket}/${k}`)
    if (!res.ok) throw new Error(`Cannot read file "${k}": HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  }

  async exists(ref: string): Promise<boolean> {
    try {
      const res = await this.send('HEAD', `/${this.bucket}/${assertFileKey(ref)}`)
      return res.ok
    } catch {
      // Malformed key or unreachable store both answer `false` — the port
      // forbids throwing here, so callers never need a third branch.
      return false
    }
  }
}
