// The kernel against the ontology file conformance cases from @dqa-ai-solutions/ontology-base (level `kernel`):
// write each case's files in the format their names say, read them with loadOntologyFiles,
// then define every entity and relationship in an in-memory ontology.
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import yaml from 'js-yaml'
import { createOntology, InMemoryAdapter } from '@dqa-ai-solutions/ontology-sdk'
import { loadOntologyFiles, clearOntologyFilesCache } from './load-ontology-files.js'
import { loadOntology } from './loaders.js'

const require = createRequire(import.meta.url)
const casesPath = require.resolve('@dqa-ai-solutions/ontology-base/conformance/cases.yaml')
interface CaseFile { name: string; content?: unknown; text?: string }
interface Case { id: string; files: CaseFile[]; expect: { schema: string; kernel: 'valid' | 'invalid'; code?: string } }
const { cases } = yaml.load(fs.readFileSync(casesPath, 'utf8')) as { cases: Case[] }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ontology-conformance-'))
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

async function kernelReads(c: Case): Promise<void> {
  const dir = path.join(tmp, c.id)
  fs.mkdirSync(dir, { recursive: true })
  const files = c.files.map((f) => {
    const p = path.join(dir, f.name)
    fs.writeFileSync(p, f.text ?? (f.name.endsWith('.json') ? JSON.stringify(f.content, null, 2) : yaml.dump(f.content)))
    return p
  })
  clearOntologyFilesCache()
  const pack = loadOntologyFiles({ files })
  const ontology = createOntology({ adapter: new InMemoryAdapter() })
  await loadOntology(ontology, { entities: [...pack.entities], relationships: [...pack.relationships] }, { tenantId: 'conformance' })
}

describe('kernel conformance — ontology files', () => {
  it('reads the cases shipped by @dqa-ai-solutions/ontology-base', () => {
    expect(cases.length).toBeGreaterThan(20)
  })

  for (const c of cases) {
    it(`${c.id}: kernel says ${c.expect.kernel}${c.expect.code ? ` (${c.expect.code})` : ''}`, async () => {
      let error: unknown
      try { await kernelReads(c) } catch (e) { error = e }
      if (c.expect.kernel === 'valid') {
        expect(error, String(error)).toBeUndefined()
      } else {
        expect(error, 'expected the kernel to refuse').toBeDefined()
        if (c.expect.code) expect((error as { code?: string }).code, String(error)).toBe(c.expect.code)
      }
    })
  }
})
