/**
 * A relationship whose two ends are the SAME entity type — a tree.
 *
 * A unit inside a unit, a target broken out of a target, a plan derived from a
 * plan. Both ends name the same entity, so a generator that derives column
 * names from the endpoint types alone emits the same name twice, and Postgres
 * refuses the whole view: `column "..." specified more than once`.
 *
 * The native generator disambiguated from the start. This one did not, so every
 * self-referencing relationship silently produced a view that could not be
 * created — and a downstream project wrote in its own notes that trees "were
 * tried and abandoned", reaching for a string pointer instead. The tree was
 * never the problem; one missing branch in one generator was.
 */

import { describe, it, expect } from 'vitest'
import { buildViewsSQL } from '../../../src/adapters/postgres/views.js'
import type { OntologySchema } from '../../../src/types/index.js'

const TREE: OntologySchema = {
  entityTypes: [{ name: 'StaffUnit', label: 'Đơn vị', properties: [{ name: 'unitName', type: 'text' }] }],
  relationshipTypes: [
    { name: 'subUnitOf', from: 'StaffUnit', to: 'StaffUnit', cardinality: '1..N', directed: true },
  ],
}

const PAIR: OntologySchema = {
  entityTypes: [
    { name: 'StaffUnit', label: 'Đơn vị', properties: [{ name: 'unitName', type: 'text' }] },
    { name: 'StaffBase', label: 'Cơ sở', properties: [{ name: 'hostName', type: 'text' }] },
  ],
  relationshipTypes: [
    { name: 'unitOfBase', from: 'StaffUnit', to: 'StaffBase', cardinality: '1..N', directed: true },
  ],
}

const columnsOf = (sql: string) => (sql.match(/AS ([a-z0-9_]+)/g) ?? []).map((m) => m.replace('AS ', ''))

describe('self-referencing relationship views', () => {
  it('does not name both endpoint columns the same', () => {
    const cols = columnsOf(buildViewsSQL(TREE))
    expect(new Set(cols).size).toBe(cols.length)
  })

  it('keeps the from-side named after the entity, and suffixes only the to-side', () => {
    const sql = buildViewsSQL(TREE)
    expect(sql).toContain('e.from_id AS staff_unit_id,')
    expect(sql).toContain('e.to_id AS staff_unit_id_2,')
  })

  it('leaves ordinary two-entity relationships exactly as they were', () => {
    // The suffix must not leak into the common case: existing views, and every
    // query already written against them, keep their column names.
    const sql = buildViewsSQL(PAIR)
    expect(sql).toContain('e.from_id AS staff_unit_id,')
    expect(sql).toContain('e.to_id AS staff_base_id,')
    expect(sql).not.toContain('_id_2')
  })
})
