import { describe, it, expect } from 'vitest'
import type { Queryable } from './db.js'
import { PgRegistryStore } from './pg-store.js'
import { resolveForClient, resolveAndLock } from './service.js'

// Fake Queryable: dispatch by a distinctive substring of each SQL statement.
// Verifies the adapter's row→ScopedRule mapping + orchestration, no real DB.
function fakeDb(handlers: Array<[RegExp, (params: unknown[]) => any[]]>, writes: any[][] = []): Queryable {
  return {
    async query(text: string, params: unknown[] = []) {
      if (/INSERT INTO .*run_manifest/s.test(text)) {
        writes.push(params)
        return { rows: [] }
      }
      for (const [re, fn] of handlers) if (re.test(text)) return { rows: fn(params) }
      throw new Error(`unmatched SQL: ${text.slice(0, 60)}`)
    },
  }
}

const baseHandlers = (): Array<[RegExp, (p: unknown[]) => any[]]> => [
  [/client_subscription/, () => [{ template_id: 'tpl-base', pinned_version: null, channel: 'stable', layer_rank: 0, owner_scope: 'firm', owner_id: 'firm-1' }]],
  [/channel_pointer_history/, () => []], // no pointer → fallback to max(published)
  [/max\(version\).*rule_template_version/s, () => [{ v: 3 }]],
  [/rule_template_member/, () => [
    { rule_id: 'R-A', version: 1, ir: { threshold: 20 } },
    { rule_id: 'R-B', version: 2, ir: {} },
  ]],
  [/owner_scope = 'client'/, () => []],
  [/rule_override/, () => []],
]

describe('PgRegistryStore.getResolveInputs — mapping', () => {
  it('subscribed base template → candidates at base layer with resolved version', async () => {
    const store = new PgRegistryStore(fakeDb(baseHandlers()))
    const { candidates, overrides } = await store.getResolveInputs('client-X', '2026-03-31')
    expect(candidates).toHaveLength(2)
    expect(candidates[0]).toMatchObject({
      ruleId: 'R-A', version: 1, layer: 0,
      source: { kind: 'base-template', ownerId: 'tpl-base', templateVersion: 3 },
    })
    expect(overrides).toEqual([])
  })

  it('client-owned rule added at client layer; override mapped', async () => {
    const h = baseHandlers()
    h[4] = [/owner_scope = 'client'/, () => [{ rule_id: 'R-C', version: 1, ir: { t: 9 } }]]
    h[5] = [/rule_override/, () => [{ rule_id: 'R-B', scope: 'client', params: null, patch: { severity: 'info' }, reason: 'hạ mức' }]]
    const store = new PgRegistryStore(fakeDb(h))
    const { candidates, overrides } = await store.getResolveInputs('client-X', '2026-03-31')
    expect(candidates.find((c) => c.ruleId === 'R-C')).toMatchObject({ layer: 100, source: { kind: 'client' } })
    expect(overrides).toEqual([{ ruleId: 'R-B', scope: 'client', patch: { severity: 'info' }, reason: 'hạ mức' }])
  })

  it('uses pinned_version instead of latest when set (no max() query needed)', async () => {
    const h = baseHandlers()
    h[0] = [/client_subscription/, () => [{ template_id: 'tpl-base', pinned_version: 2, channel: 'stable', layer_rank: 0, firm_id: 'firm-1' }]]
    h[2] = [/max\(version\)/, () => { throw new Error('should not query latest when pinned') }]
    const store = new PgRegistryStore(fakeDb(h))
    const { candidates } = await store.getResolveInputs('client-X', '2026-03-31')
    expect(candidates[0].source.templateVersion).toBe(2)
  })
})

describe('resolveForClient / resolveAndLock — end to end over fake DB', () => {
  it('merges base + client + override and writes the lockfile', async () => {
    const h = baseHandlers()
    h[4] = [/owner_scope = 'client'/, () => [{ rule_id: 'R-A', version: 5, ir: { threshold: 5 } }]] // shadows base R-A
    h[5] = [/rule_override/, () => [{ rule_id: 'R-B', scope: 'client', params: { k: 1 }, patch: null, reason: 'vặn ngưỡng' }]]
    const writes: any[][] = []
    const store = new PgRegistryStore(fakeDb(h, writes))

    const { rules, params } = await resolveForClient(store, 'client-X', '2026-03-31')
    // R-A resolve về bản của khách (v5, shadow base). R-B VẪN trong tập — override chỉ vặn ngưỡng,
    // không làm luật biến mất (§12.2). Trước đây `enabled=false` drop R-B ⇒ chỉ còn 1 luật.
    expect(rules).toHaveLength(2)
    expect(rules[0]).toMatchObject({ ruleId: 'R-A', version: 5, source: { kind: 'client' } })
    expect(params).toEqual({ k: 1 })

    const res = await resolveAndLock(store, 'run-1', 'client-X', '2026-03-31')
    expect(writes).toHaveLength(1)
    const [runId, clientId, asOf, rulesJson, , hash] = writes[0]
    expect(runId).toBe('run-1')
    expect(clientId).toBe('client-X')
    expect(asOf).toBe('2026-03-31')
    expect(JSON.parse(rulesJson as string)).toHaveLength(2)   // lockfile ghi TRỌN tập luật đã resolve
    expect(hash).toBe(res.manifest.hash)
  })
})
