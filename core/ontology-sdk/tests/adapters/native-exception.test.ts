/**
 * EXCEPTION CASES, SECOND HALF — what a REAL Postgres does with the edge
 * values the guard lets through, and with the junk it now stops.
 *
 * `tests/api/exception-inputs.test.ts` proves the guard's verdicts on the
 * in-memory store, where a value always comes back as it went in. A real
 * driver and real column types do not promise that:
 *
 *   · `numeric` comes back from node-postgres as a STRING;
 *   · a `date` can come back as a JS Date at local midnight — one day early
 *     for every reader west of UTC;
 *   · a `text` column rejects U+0000 outright.
 *
 * So every value the guard ACCEPTS is written through the native-table store
 * and read back: it must be equal, not "equal after a cast". And a few values
 * the guard REJECTS are sent straight to the store, bypassing it, to record
 * what the guard is standing in front of.
 *
 * Skipped unless PARITY_DB_URL points at a database this test may create and
 * drop schemas in.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NativeTableAdapter } from '../../src/adapters/postgres/native-table-adapter.js'
import { collectInstanceDataErrors } from '../../src/core/graph/validation.js'
import {
  DEFAULT_TEXT_MAX_LENGTH,
  type EntityTypeDef,
  type OntologySchema,
  type Provenance,
} from '../../src/types/index.js'

const URL = process.env['PARITY_DB_URL']
const SCHEMA = 't_exception_native'

const PROBE: EntityTypeDef = {
  name: 'Probe',
  label: 'Probe',
  properties: [
    { name: 'note', type: 'text' },
    { name: 'free', type: 'number' },
    { name: 'day', type: 'date' },
    { name: 'at', type: 'datetime' },
    { name: 'tags', type: 'text[]' },
    { name: 'meta', type: 'json' },
  ],
}
const ONT: OntologySchema = { entityTypes: [PROBE], relationshipTypes: [] }
const prov: Provenance = { source_ref: 'exception', confirmed_by: 'test', confirmed_at: '2026-09-12T00:00:00Z' }

let a: NativeTableAdapter
beforeAll(async () => {
  if (!URL) return
  a = new NativeTableAdapter({ connectionString: URL, ontology: ONT }, SCHEMA)
  const raw = a as unknown as { pool: { query(s: string): Promise<unknown> } }
  await raw.pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
  await a.applySchema(ONT)
})
afterAll(async () => {
  if (!URL) return
  const raw = a as unknown as { pool: { query(s: string): Promise<unknown> } }
  await raw.pool.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`)
  await a.close()
})

const ACCEPTED: [prop: string, value: unknown][] = [
  ['note', 'Nguyễn Thị Ánh Tuyết'],
  ['note', 'dòng một\ndòng hai\r\n\tthụt lề'],
  ['note', 'emoji 🇻🇳 và chữ Hán 漢字'],
  ['note', "O'Brien; DROP TABLE x; --"],
  ['note', 'x'.repeat(DEFAULT_TEXT_MAX_LENGTH)],
  ['note', ''],
  ['free', 0],
  ['free', -5],
  ['free', 0.1],
  ['free', 33.3],
  ['free', Number.MAX_SAFE_INTEGER],
  ['free', Number.MIN_SAFE_INTEGER],
  ['free', 4_500_000_000],
  ['day', '2026-09-12'],
  ['day', '2024-02-29'],
  ['day', '0001-01-01'],
  ['day', '9999-12-31'],
  ['tags', []],
  ['tags', ['a', 'dấu phẩy, và "nháy"', '{ngoặc}']],
  ['meta', { a: 1, b: ['x', { c: true }], s: 'chữ' }],
]

describe.skipIf(URL === undefined)('native store — accepted edge values come back unchanged', () => {
  for (const [prop, value] of ACCEPTED) {
    const label = typeof value === 'string' && value.length > 30 ? `${value.slice(0, 10)}…(${value.length})` : JSON.stringify(value)
    it(`${prop} = ${label}`, async () => {
      expect(collectInstanceDataErrors(PROBE, { [prop]: value }, { partial: false })).toEqual([])
      const ins = await a.insertInstance('Probe', { [prop]: value }, prov)
      const got = await a.getInstance(ins.id)
      expect(got?.data[prop]).toEqual(value)
    })
  }

  // A datetime is an INSTANT: the store may rewrite its spelling, never its moment.
  for (const at of ['2026-09-12T10:00:00Z', '2026-09-12T10:00:00.123+07:00', '2026-09-12T23:30:00-05:00']) {
    it(`at = ${at} keeps its instant`, async () => {
      expect(collectInstanceDataErrors(PROBE, { at }, { partial: false })).toEqual([])
      const ins = await a.insertInstance('Probe', { at }, prov)
      const got = await a.getInstance(ins.id)
      expect(new Date(String(got?.data['at'])).getTime()).toBe(new Date(at).getTime())
    })
  }
})

describe.skipIf(URL === undefined)('native store — what the guard is standing in front of', () => {
  // Sent straight to the store, bypassing the guard. Each one used to reach here.
  const NUL = String.fromCharCode(0)
  const junk: [prop: string, value: unknown][] = [
    ['note', `a${NUL}b`],
    ['day', '2026-02-31'],
    ['day', '1'],
    ['day', 'hello 2'],
  ]
  for (const [prop, value] of junk) {
    it(`${prop} = ${JSON.stringify(value)} — the guard refuses it, and the database would have thrown a raw error`, async () => {
      expect(collectInstanceDataErrors(PROBE, { [prop]: value }, { partial: false }).length).toBeGreaterThan(0)
      await expect(a.insertInstance('Probe', { [prop]: value }, prov)).rejects.toThrow()
    })
  }
})
