// Cơ chế OVERLAY (override-by-id) — nền cho overlay ngành (Phase 6). Hai phần:
//  1) overrideLast() — semantics thuần: layer sau thắng theo id/name.
//  2) loadFunctions([base, overlay]) — nạp nhiều dir thật, overlay ADD + REPLACE base.
// Fixture là .js xuất object {kind:'rule',…} thuần (isFnSpec chỉ kiểm `kind`) → không cần import.
import { describe, it, expect, afterAll } from 'vitest'
import fs from 'fs-extra'
import os from 'node:os'
import path from 'node:path'
import { createOntology, InMemoryAdapter, type Ctx } from '@dqa-ai-solutions/ontology-sdk'
import { loadFunctions, overrideLast } from './load-functions.js'

const ctx: Ctx = { tenantId: 't', actor: 'a' }
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overlay-'))
afterAll(() => fs.removeSync(tmp))

describe('overrideLast (semantics)', () => {
  it('layer sau thắng theo rule id; id mới được THÊM', () => {
    const merged = overrideLast({
      computes: [{ kind: 'compute', name: 'f', body: () => 1 } as never, { kind: 'compute', name: 'f', body: () => 2 } as never],
      actions: [],
      rulesByType: {
        T: [
          { kind: 'rule', on: 'T', id: 'R-A', khi: () => true } as never, // base
          { kind: 'rule', on: 'T', id: 'R-B', khi: () => true } as never, // base
          { kind: 'rule', on: 'T', id: 'R-A', khi: () => false } as never, // overlay override
          { kind: 'rule', on: 'T', id: 'R-C', khi: () => true } as never, // overlay add
        ],
      },
    })
    expect(merged.rulesByType.T.map((r) => r.id).sort()).toEqual(['R-A', 'R-B', 'R-C'])
    expect(merged.rulesByType.T.find((r) => r.id === 'R-A')!.khi!({} as never, {} as never)).toBe(false) // overlay
    expect(merged.computes).toHaveLength(1) // compute 'f' deduped, last wins
  })
})

describe('loadFunctions (layered từ đĩa)', () => {
  it('overlay ADD luật mới + REPLACE luật base cùng id', async () => {
    const base = path.join(tmp, 'base')
    const overlay = path.join(tmp, 'overlay')
    await fs.ensureDir(base)
    await fs.ensureDir(overlay)
    // base: R-A (khớp 'x'), R-B
    await fs.writeFile(path.join(base, 'b.js'), `
      export const a = { kind:'rule', on:'G', id:'R-A', khi: (g)=> g.data.k==='x' }
      export const b = { kind:'rule', on:'G', id:'R-B', khi: ()=> false }
    `)
    // overlay: R-A bị thay (khớp 'y'), thêm R-C
    await fs.writeFile(path.join(overlay, 'o.js'), `
      export const a = { kind:'rule', on:'G', id:'R-A', khi: (g)=> g.data.k==='y' }
      export const c = { kind:'rule', on:'G', id:'R-C', khi: ()=> true }
    `)

    const ont = createOntology({ adapter: new InMemoryAdapter() })
    const base1 = await loadFunctions(ont, base, ctx) // chỉ base
    expect(base1.G.map((r) => r.id).sort()).toEqual(['R-A', 'R-B'])

    const ont2 = createOntology({ adapter: new InMemoryAdapter() })
    const merged = await loadFunctions(ont2, [base, overlay], ctx) // base + overlay
    expect(merged.G.map((r) => r.id).sort()).toEqual(['R-A', 'R-B', 'R-C']) // C added
    const rA = merged.G.find((r) => r.id === 'R-A')!
    expect(await rA.khi!({ data: { k: 'y' } } as never, {} as never)).toBe(true) // overlay version
    expect(await rA.khi!({ data: { k: 'x' } } as never, {} as never)).toBe(false) // base version gone
  })
})
