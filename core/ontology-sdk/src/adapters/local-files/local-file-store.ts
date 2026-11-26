// LocalFileStore — the FileStore port over a plain directory tree. The
// filesystem counterpart to FilesystemAdapter: no external service required,
// human-inspectable, and the default an app gets when it declares nothing.
//
// Layout (<root>/): the key IS the relative path, so `decisions/12-QD.png`
// lands at `<root>/decisions/12-QD.png`. Keys stay legible on disk on purpose —
// an operator holding a reference from the database must be able to find the
// file without a lookup table.
//
// Uses write-to-tmp + rename, same as FilesystemAdapter: a crash mid-write
// leaves the previous bytes intact rather than a truncated file that still
// answers `exists` with `true`.
//
// ⚠️ Suitable for a single node. Two processes on different machines do NOT
//    share a directory, so a multi-node deployment wants S3FileStore — that is
//    the whole reason the port exists.

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, unlink, access } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { assertFileKey, FileKeyError, type FileStore } from '../../ports/file-store.js'

export interface LocalFileStoreOptions {
  /** Directory that holds every file. Created on first write. */
  root: string
}

export class LocalFileStore implements FileStore {
  private readonly root: string

  constructor(opts: LocalFileStoreOptions) {
    this.root = resolve(opts.root)
  }

  /**
   * Resolve a key to an absolute path, and prove it stayed inside the root.
   *
   * `assertFileKey` already rejects `..` segments, so this is the SECOND fence
   * on the same hazard. It is not redundant: the key contract is a promise the
   * port makes, while this is the filesystem refusing to be walked out of —
   * and on the day someone relaxes the contract, this is what still holds.
   */
  private pathFor(key: string): string {
    const k = assertFileKey(key)
    const path = resolve(this.root, k)
    if (path !== this.root && !path.startsWith(this.root + sep)) throw new FileKeyError(key)
    return path
  }

  async put(key: string, bytes: Buffer | Uint8Array): Promise<{ ref: string }> {
    const path = this.pathFor(key)
    await mkdir(dirname(path), { recursive: true })
    // Temp file sits in the SAME directory: `rename` is only atomic within one
    // filesystem, and /tmp is routinely a different mount.
    const tmp = join(dirname(path), `.${randomUUID()}.tmp`)
    try {
      await writeFile(tmp, bytes)
      await rename(tmp, path)
    } catch (err) {
      await unlink(tmp).catch(() => {}) // best effort; the original is untouched
      throw err
    }
    return { ref: assertFileKey(key) }
  }

  async get(ref: string): Promise<Buffer> {
    return readFile(this.pathFor(ref))
  }

  async exists(ref: string): Promise<boolean> {
    try {
      await access(this.pathFor(ref))
      return true
    } catch {
      return false
    }
  }
}
