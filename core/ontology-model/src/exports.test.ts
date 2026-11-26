// What consumers load is dist/. The core is the part every side shares, so it must be loadable
// without Node or a driver, and it must hand on the base declarations as real ESM named exports.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const dist = fileURLToPath(new URL('../dist/', import.meta.url))
const files = (d: string): string[] => readdirSync(d).flatMap((f) => statSync(join(d, f)).isDirectory() ? files(join(d, f)) : [join(d, f)])

describe('dist', () => {
  for (const entry of ['index', 'kernel']) {
    it(`${entry}: re-exports every runtime value of @dqa-ai-solutions/ontology-base`, async () => {
      const esm = await import(`${dist}${entry}.js`)
      for (const name of Object.keys(await import('@dqa-ai-solutions/ontology-base'))) expect(esm, name).toHaveProperty(name)
    })
  }

  it('one copy of every class: the kernel hands on the same bindings as the root', async () => {
    const root = await import(`${dist}index.js`)
    const kernel = await import(`${dist}kernel.js`)
    for (const name of Object.keys(root)) expect(kernel[name], name).toBe(root[name])
  })

  it('imports no Node builtin and no driver', () => {
    for (const f of files(dist).filter((f) => f.endsWith('.js')))
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/from\s*["'](node:|pg|neo4j-driver|@qdrant)|require\(/)
  })
})
