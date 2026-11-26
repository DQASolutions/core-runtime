/**
 * The native-table store must answer EXACTLY as the jsonb store does.
 *
 * This is the decisive test for the whole switch: one sequence of operations,
 * run through both adapters, results compared. It needs a real Postgres because
 * the two divergences that actually bite only appear with a real driver and
 * real column types:
 *
 *   · node-postgres hands `numeric` back as a STRING — 30 comes back as "30",
 *     and matchesProperties compares with ===, so `age = 30` quietly stops
 *     matching. Found by this test, not by review.
 *   · a NULL column and an absent jsonb key are different things under `!=`.
 *
 * Skipped unless PARITY_DB_URL points at a database this test may create and
 * drop schemas in.
 */
import { describe, it, expect } from 'vitest'
import { PostgresAdapter } from '../../src/adapters/postgres/postgres-adapter.js'
import { NativeTableAdapter } from '../../src/adapters/postgres/native-table-adapter.js'
import type { ConditionExpr, OntologySchema, Provenance } from '../../src/types/index.js'

const URL = process.env['PARITY_DB_URL']

const ONT: OntologySchema = {
  entityTypes: [
    {
      name: 'Person',
      label: 'Người',
      properties: [
        { name: 'fullName', type: 'text' },
        { name: 'age', type: 'number' },
        { name: 'joinedOn', type: 'date' },
        { name: 'active', type: 'text' },
      ],
    },
    { name: 'Unit', label: 'Đơn vị', properties: [{ name: 'unitName', type: 'text' }] },
    { name: 'Tag', label: 'Nhãn', properties: [{ name: 'label', type: 'text' }] },
  ],
  relationshipTypes: [
    { name: 'inUnit', from: 'Person', to: 'Unit', cardinality: '1..N', directed: true },
    { name: 'hasMember', from: 'Unit', to: 'Person', cardinality: 'N..1', directed: true },
    { name: 'tagged', from: 'Person', to: 'Tag', cardinality: 'N..N', directed: true },
  ],
}

const prov: Provenance = {
  source_ref: 'parity',
  confirmed_by: 'test',
  confirmed_at: new Date().toISOString(),
}

const compare = (name: string, cmp: '=' | '!=', value: string): ConditionExpr => ({
  op: 'compare',
  left: { kind: 'property', entity: 'Person', name },
  cmp,
  right: { kind: 'literal', value },
})

/** Key order of a JS object is not part of the contract; sort before comparing. */
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v !== null && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortDeep((v as Record<string, unknown>)[k])]),
    )
  }
  return v
}

async function run(kind: 'jsonb' | 'native'): Promise<unknown[]> {
  const schema = kind === 'jsonb' ? 't_par_jsonb' : 't_par_native'
  const a =
    kind === 'jsonb'
      ? new PostgresAdapter({ connectionString: URL as string }, schema)
      : new NativeTableAdapter({ connectionString: URL as string, ontology: ONT }, schema)
  const raw = a as unknown as { pool: { query(s: string): Promise<unknown> } }
  await raw.pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  await a.applySchema(ONT)

  const out: unknown[] = []
  const p1 = await a.insertInstance(
    'Person',
    { fullName: 'Lê Văn A', age: 30, joinedOn: '2024-03-01' },
    prov,
  )
  const p2 = await a.insertInstance('Person', { fullName: 'Đỗ Thị B', age: 41 }, prov)
  const u1 = await a.insertInstance('Unit', { unitName: 'Tổ 1' }, prov)
  const t1 = await a.insertInstance('Tag', { label: 'chủ chốt' }, prov)
  out.push(['insert', p1.data, p2.data, u1.data, t1.data])

  const got = await a.getInstance(p1.id)
  out.push(['get', got?.entityType, got?.data])
  out.push(['getMissing', await a.getInstance('00000000-0000-0000-0000-000000000000')])

  const upd = await a.updateInstance(p2.id, { age: 42, active: 'yes' }, prov)
  out.push(['update', upd.data])

  const all = await a.queryInstances('Person', null)
  out.push(['queryAll', all.map((i) => JSON.stringify(sortDeep(i.data))).sort()])
  const hit = await a.queryInstances('Person', compare('fullName', '=', 'Lê Văn A'))
  out.push(['queryEq', hit.map((i) => i.data['fullName'])])
  // `active` is absent on p1 — JS says undefined !== 'yes', so p1 must come back.
  const neHit = await a.queryInstances('Person', compare('active', '!=', 'yes'))
  out.push(['queryNeMissingKey', neHit.map((i) => i.data['fullName']).sort()])

  await a.insertEdge('inUnit', p1.id, u1.id, prov)
  await a.insertEdge('hasMember', u1.id, p2.id, prov)
  await a.insertEdge('tagged', p1.id, t1.id, prov)
  const inUnit = await a.queryEdges({ relationship: 'inUnit' })
  const hasMember = await a.queryEdges({ relationship: 'hasMember', fromId: u1.id })
  const tagged = await a.queryEdges({ relationship: 'tagged' })
  const fromP1 = await a.queryEdges({ fromId: p1.id })
  out.push([
    'edges',
    inUnit.map((e) => [e.fromId === p1.id, e.toId === u1.id]),
    hasMember.map((e) => [e.fromId === u1.id, e.toId === p2.id]),
    tagged.map((e) => [e.fromId === p1.id, e.toId === t1.id]),
    fromP1.length,
  ])

  await a.deleteEdge('inUnit', p1.id, u1.id)
  out.push(['afterDelete', (await a.queryEdges({ relationship: 'inUnit' })).length])
  await a.close()
  return out
}

describe.skipIf(URL === undefined)('native store answers exactly as the jsonb store', () => {
  it('same sequence of operations, same results', async () => {
    const jsonb = await run('jsonb')
    const native = await run('native')
    expect(native.length).toBe(jsonb.length)
    for (let i = 0; i < jsonb.length; i++) {
      expect(sortDeep(native[i]), `step ${i}`).toEqual(sortDeep(jsonb[i]))
    }
  }, 60_000)
})
