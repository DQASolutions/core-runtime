// The file capability contract. Entirely separate from StorageAdapter — a
// tenant whose ontology has no `file` property runs the structural graph +
// rules with NO FileStore at all. (Same shape as the VectorAdapter port next
// door, and for the same reason: an optional capability must be *absent*, not
// stubbed.)
//
// WHY THIS LIVES IN THE SDK
//
// `PropertyType` gained `'file'` in 5.5.0 — a property whose value is a
// REFERENCE to a stored file. The SDK therefore already asserts "this string
// points at bytes". A package that can say that and cannot resolve it is a
// package that has published a promise it does not keep, so the port that
// resolves the reference belongs here, beside the type that mints it.
//
// WHAT IT IS NOT
//
//   • Not a document store. It moves opaque bytes; it does not parse, index,
//     convert or classify them (that is `@dqa-ai-solutions/ingest-documents`).
//   • Not a place for metadata. `put` takes bytes and nothing else, so every
//     adapter can satisfy it — a plain directory has nowhere to put a
//     content-type. Who uploaded / when / under what original name is a
//     question the ONTOLOGY answers, on the instance that owns the reference,
//     where it is queryable and provenance-tracked. Do not grow this port to
//     duplicate that; a fact recorded in two places disagrees eventually.
//   • Not transactional. A `put` that lands and an instance write that then
//     rolls back leaves an orphan blob. That is the accepted trade (an orphan
//     blob is inert; a dangling reference is not) — so write the FILE FIRST and
//     the reference second, never the reverse.

/**
 * A byte store addressed by opaque keys.
 *
 * KEY CONTRACT — the caller owns key layout; the adapter owns durability.
 * A key is a `/`-separated path of non-empty segments (`decisions/12-QD.png`).
 * It MUST NOT start with `/`, contain empty segments, or contain `.` / `..`.
 * Implementations reject anything else rather than normalising it: silently
 * rewriting a key produces a file nobody can address again, which is a file
 * that is gone.
 *
 * Keys may contain any Unicode letter — they routinely carry non-ASCII document
 * numbers — so adapters that speak HTTP must percent-encode UTF-8 exactly, and
 * identically in both the request line and any signature over it.
 */
export interface FileStore {
  /**
   * Store `bytes` at `key`, overwriting whatever was there.
   *
   * Returns the reference to persist on the owning instance. It is the key —
   * returned rather than assumed so an adapter that must rewrite (a prefix, a
   * generation id) can, and the caller stores what actually resolves.
   */
  put(key: string, bytes: Buffer | Uint8Array): Promise<{ ref: string }>

  /** Read the bytes at `ref`. Throws if absent — a missing file is a broken
   *  reference, and a caller that wanted a maybe should have asked `exists`. */
  get(ref: string): Promise<Buffer>

  /**
   * Whether `ref` resolves. NEVER throws: a malformed key and an unreachable
   * backend both answer `false`, because every caller of this method is asking
   * "can I show this?" and has no branch for "I could not find out".
   */
  exists(ref: string): Promise<boolean>
}

/** Thrown for a key that violates the key contract. */
export class FileKeyError extends Error {
  constructor(key: string) {
    super(`Invalid file key: ${JSON.stringify(key)}`)
    this.name = 'FileKeyError'
  }
}

/**
 * The one key validator, shared by every adapter so they agree.
 *
 * Rejecting `..` matters most for the filesystem adapter (where it escapes the
 * root) but is enforced everywhere: two implementations of one port that accept
 * different key sets are a bug that only shows up on the day you switch
 * backends, which is the worst day to find it.
 */
export function assertFileKey(key: string): string {
  const k = String(key)
  if (
    k.length === 0 ||
    k.startsWith('/') ||
    k.includes('//') ||
    k.includes('\0') ||
    k.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')
  ) {
    throw new FileKeyError(key)
  }
  return k
}
