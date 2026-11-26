// The ontology file schema against the conformance cases (level `schema`), and its two forms.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yaml from 'js-yaml'
import { Ajv } from 'ajv'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const jsonSchema = JSON.parse(fs.readFileSync(path.join(root, 'schema/ontology-file.schema.json'), 'utf8'))
const yamlSchema = yaml.load(fs.readFileSync(path.join(root, 'schema/ontology-file.schema.yaml'), 'utf8'))

interface CaseFile { name: string; content?: unknown; text?: string }
interface Case { id: string; files: CaseFile[]; expect: { schema: 'valid' | 'invalid'; kernel: 'valid' | 'invalid'; code?: string } }
const { version, cases } = yaml.load(fs.readFileSync(path.join(root, 'conformance/cases.yaml'), 'utf8')) as { version: number; cases: Case[] }

/** Serialize a case file the way its name says, then read it back the way the kernel does. */
const asRead = (f: CaseFile): unknown => {
  const text = f.text ?? (f.name.endsWith('.json') ? JSON.stringify(f.content) : yaml.dump(f.content))
  return yaml.load(text) ?? {} // an empty file is an empty mapping
}

const ajv = new Ajv({ allErrors: true, strict: false })
const validate = ajv.compile(jsonSchema)

describe('ontology file schema', () => {
  it('is published in JSON and YAML with the same content', () => {
    expect(yamlSchema).toEqual(jsonSchema)
  })

  it('cases file is version 1 and ids are unique', () => {
    expect(version).toBe(1)
    expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length)
  })

  it('covers both formats and both verdict levels', () => {
    const names = cases.flatMap((c) => c.files.map((f) => f.name))
    expect(names.some((n) => /\.ya?ml$/.test(n))).toBe(true)
    expect(names.some((n) => n.endsWith('.json'))).toBe(true)
    expect(cases.some((c) => c.expect.schema === 'valid' && c.expect.kernel === 'invalid')).toBe(true)
  })

  for (const c of cases) {
    it(`${c.id}: schema says ${c.expect.schema}`, () => {
      const results = c.files.map((f) => ({ file: f.name, ok: validate(asRead(f)), errors: validate.errors }))
      const ok = results.every((r) => r.ok)
      if (ok !== (c.expect.schema === 'valid')) {
        throw new Error(`expected ${c.expect.schema}, got ${ok ? 'valid' : 'invalid'}: ${JSON.stringify(results.filter((r) => !r.ok), null, 1)}`)
      }
    })
  }
})
