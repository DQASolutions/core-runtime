// Neo4j adapter smoke test — a self-contained round-trip against a LIVE server.
// Skipped unless NEO4J_URL is set, so it never blocks the default suite.
//
//   docker run -p7687:7687 -p7474:7474 -e NEO4J_AUTH=neo4j/password neo4j:5
//   NEO4J_URL=bolt://localhost:7687 NEO4J_PASSWORD=password \
//     npm test --workspace @dqa-ai-solutions/ontology-sdk -- neo4j.smoke
//
// For the FULL parity suite against Neo4j: `npm run test:neo4j` (same package).

import { describe, it, expect, afterAll } from 'vitest'
import { Neo4jAdapter } from '../../src/index.js'
import type { Provenance, RuleDef } from '../../src/types/index.js'

const LIVE = Boolean(process.env['NEO4J_URL'])
const PROV: Provenance = { source_ref: 'smoke', confirmed_by: 'test', confirmed_at: '2026-01-01T00:00:00.000Z' }

describe.skipIf(!LIVE)('Neo4jAdapter — live round-trip', () => {
  const adapter = new Neo4jAdapter().withTenant('smoke-tenant') as Neo4jAdapter
  afterAll(() => adapter.close())

  it('instances: insert → get → update → query(filter)', async () => {
    await adapter.applySchema({ entityTypes: [], relationshipTypes: [] })
    const a = await adapter.insertInstance('GiaoDich', { amount: 5_000_000, category: 'xăng' }, PROV)
    expect(await adapter.getInstance(a.id)).toMatchObject({ id: a.id, data: { amount: 5_000_000 } })

    await adapter.updateInstance(a.id, { category: 'tiếp khách' }, PROV)
    const all = await adapter.queryInstances('GiaoDich', null)
    expect(all).toHaveLength(1)
    expect(all[0]?.data['category']).toBe('tiếp khách')

    // ConditionExpr filter is applied in JS (parity with other adapters).
    const hit = await adapter.queryInstances('GiaoDich', {
      op: 'compare',
      left: { kind: 'property', entity: 'GiaoDich', name: 'amount' },
      cmp: '>',
      right: { kind: 'literal', value: 1_000_000 },
    })
    expect(hit).toHaveLength(1)
  })

  it('edges: insert is idempotent, query, delete', async () => {
    const x = await adapter.insertInstance('A', {}, PROV)
    const y = await adapter.insertInstance('B', {}, PROV)
    const e1 = await adapter.insertEdge('rel', x.id, y.id, PROV)
    const e2 = await adapter.insertEdge('rel', x.id, y.id, PROV) // duplicate → same edge
    expect(e2.id).toBe(e1.id)
    expect(await adapter.queryEdges({ fromId: x.id })).toHaveLength(1)
    await adapter.deleteEdge('rel', x.id, y.id)
    expect(await adapter.queryEdges({ fromId: x.id })).toHaveLength(0)
  })

  it('rules: insertIfAbsent, query, atomic disable bumps version', async () => {
    const rule: RuleDef = {
      id: 'r-smoke', name: 'r', kind: 'CUSTOM', appliesTo: 'GiaoDich',
      condition: { op: 'count', relationship: 'rel', cmp: '>=', n: 1 },
      severity: 'CANH_BAO', message: 'm', enabled: true, version: 1, ...PROV,
    }
    expect(await adapter.insertRuleIfAbsent(rule)).toBe(true)
    expect(await adapter.insertRuleIfAbsent(rule)).toBe(false) // already present
    expect(await adapter.atomicDisableRule('r-smoke', PROV)).toBe('ok')
    const got = await adapter.getRule('r-smoke')
    expect(got?.enabled).toBe(false)
    expect(got?.version).toBe(2)
  })
})
