import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { createOntology, InMemoryAdapter, type Ctx, type Provenance } from '@dqa-ai-solutions/ontology-sdk'
import { loadFunctions } from './load-functions.js'

const CTX: Ctx = { tenantId: 'test', actor: 'tester' }
const PROV: Provenance = { source_ref: 'test', confirmed_by: 'tester', confirmed_at: '2026-01-01T00:00:00.000Z' }

// A self-contained compiled functions module (plain spec literals — no import,
// so the fixture stands alone; matches what `collectSpecs` recognises by `kind`).
const FIXTURE = `
export const reconDelta = { kind: 'compute', name: 'reconDelta', body: () => 42 }
export const greet = { kind: 'action', name: 'greet', effect: () => [{ type: 'greeted', aggregate: 'a1' }] }
export const r1 = { kind: 'rule', on: 'GiaoDich', id: 'R-A', khi: () => true }
export const r2 = { kind: 'rule', on: 'KyKeToan', id: 'R-B', timViPham: () => [] }
`

describe('loadFunctions', () => {
  let dir: string
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fn-app-'))
    await fs.mkdirp(path.join(dir, 'functions'))
    await fs.writeFile(path.join(dir, 'functions', 'mod.js'), FIXTURE)
  })
  afterAll(async () => {
    await fs.remove(dir)
  })

  it('returns {} when the functions dir is absent', async () => {
    const ont = createOntology({ adapter: new InMemoryAdapter() })
    expect(await loadFunctions(ont, path.join(dir, 'nope'), CTX)).toEqual({})
  })

  it('binds compute bodies (callable via callFunction)', async () => {
    const ont = createOntology({ adapter: new InMemoryAdapter() })
    await loadFunctions(ont, path.join(dir, 'functions'), CTX)
    expect(await ont.callFunction('reconDelta', {}, CTX)).toBe(42)
  })

  it('binds action bodies (applicable via applyAction, emitting events)', async () => {
    const ont = createOntology({ adapter: new InMemoryAdapter() })
    await loadFunctions(ont, path.join(dir, 'functions'), CTX)
    const events = await ont.applyAction('greet', {}, PROV, CTX)
    expect(events.map((e) => e.type)).toContain('greeted')
  })

  it('returns rules grouped by entity type', async () => {
    const ont = createOntology({ adapter: new InMemoryAdapter() })
    const rulesByType = await loadFunctions(ont, path.join(dir, 'functions'), CTX)
    expect(rulesByType['GiaoDich'].map((r) => r.id)).toEqual(['R-A'])
    expect(rulesByType['KyKeToan'].map((r) => r.id)).toEqual(['R-B'])
  })
})
