import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import type { EntityTypeDef } from '@dqa-ai-solutions/ontology-sdk'
import { loadOntologyFiles, clearOntologyFilesCache } from './load-ontology-files.js'

const dir = path.join(os.tmpdir(), 'fos-ontology-files-test')
const a = path.join(dir, 'a.yaml')
const b = path.join(dir, 'b.yaml')

const A = `
valueTypes:
  - { name: code6, type: text, pattern: '^[0-9]{6}$' }
entities:
  - name: Unit
    properties:
      - { name: code, type: text, valueType: code6 }
      - { name: provinceCode, type: text }
relationships:
  - { name: unitOf, from: Unit, to: Unit, cardinality: many-to-one }
accepted:
  - { change: x }
`
const B = `
entities:
  - name: Person
    properties:
      - { name: fullName, type: text }
`

// Bump mtime explicitly: two writes inside one mtime tick look unchanged to a stat.
async function write(p: string, text: string, tick: number) {
  await fs.writeFile(p, text)
  const t = new Date(Date.now() + tick * 1000)
  await fs.utimes(p, t, t)
}

beforeEach(async () => {
  clearOntologyFilesCache()
  await fs.emptyDir(dir)
  await write(a, A, 0)
  await write(b, B, 0)
})
afterAll(async () => { await fs.remove(dir) })

describe('loadOntologyFiles', () => {
  it('merges files and resolves value types into properties', () => {
    const pack = loadOntologyFiles({ files: [a, b] })
    expect(pack.entities.map((e) => e.name)).toEqual(['Unit', 'Person'])
    expect(pack.relationships.map((r) => r.name)).toEqual(['unitOf'])
    const code = pack.entities[0]!.properties.find((p) => p.name === 'code') as unknown as Record<string, unknown>
    expect(code.pattern).toBe('^[0-9]{6}$')
    expect(code.valueTypeOf).toBe('code6')
    // the raw doc keeps the declaration as written, extra array keys included
    expect((pack.doc.entities[0]!.properties[0] as unknown as Record<string, unknown>).valueType).toBe('code6')
    expect(pack.doc.accepted).toEqual([{ change: 'x' }])
  })

  it('returns the SAME frozen object while no file changes', () => {
    const p1 = loadOntologyFiles({ files: [a, b] })
    const p2 = loadOntologyFiles({ files: [a, b] })
    expect(p2).toBe(p1)
    expect(Object.isFrozen(p1.entities[0]!.properties[0])).toBe(true)
    expect(() => { (p1.entities as EntityTypeDef[]).push({ name: 'X', label: 'X', properties: [] } satisfies EntityTypeDef) }).toThrow()
  })

  it('reloads when a file is edited, and the version follows the content', async () => {
    const p1 = loadOntologyFiles({ files: [a, b] })
    await write(b, B.replace('fullName', 'displayName'), 5)
    const p2 = loadOntologyFiles({ files: [a, b] })
    expect(p2).not.toBe(p1)
    expect(p2.version).not.toBe(p1.version)
    expect(p2.entities[1]!.properties[0]!.name).toBe('displayName')
    // touched but identical content ⇒ reloaded, same version
    await write(b, B.replace('fullName', 'displayName'), 10)
    const p3 = loadOntologyFiles({ files: [a, b] })
    expect(p3).not.toBe(p2)
    expect(p3.version).toBe(p2.version)
  })

  it('reloads when the file list changes', () => {
    const p1 = loadOntologyFiles({ files: [a] })
    const p2 = loadOntologyFiles({ files: [a, b] })
    expect(p1.entities).toHaveLength(1)
    expect(p2.entities).toHaveLength(2)
  })

  it('refuses the same entity name in two files, naming both', async () => {
    await write(b, A.replace(/valueTypes:[\s\S]*?entities:/, 'entities:').replace(/relationships:[\s\S]*/, ''), 5)
    expect(() => loadOntologyFiles({ files: [{ path: a, label: 'base' }, { path: b, label: 'qt-1' }] }))
      .toThrow(/Entity "Unit" is declared in both "base" and "qt-1"/)
  })

  it('applies transformEntity before value types resolve, and caches with it', () => {
    const stamp = (e: EntityTypeDef): EntityTypeDef =>
      e.properties.some((p) => p.name === 'provinceCode')
        ? { ...e, properties: [...e.properties, { name: 'ownerUnit', type: 'text' } as EntityTypeDef['properties'][number]] }
        : e
    const p1 = loadOntologyFiles({ files: [a, b], transformEntity: stamp })
    expect(p1.entities[0]!.properties.map((p) => p.name)).toContain('ownerUnit')
    expect(p1.entities[1]!.properties.map((p) => p.name)).not.toContain('ownerUnit')
    expect(loadOntologyFiles({ files: [a, b], transformEntity: stamp })).toBe(p1)
    // a different transform is a different load
    expect(loadOntologyFiles({ files: [a, b] }).entities[0]!.properties.map((p) => p.name)).not.toContain('ownerUnit')
  })

  it('fails on a property naming an undeclared value type', async () => {
    await write(b, B.replace('{ name: fullName, type: text }', '{ name: fullName, type: text, valueType: nope }'), 5)
    expect(() => loadOntologyFiles({ files: [a, b] })).toThrow(/value type "nope", which is not declared/)
  })
})
