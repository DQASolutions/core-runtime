/**
 * PropertyType `catalogue` — a value drawn from a list that lives as ROWS in
 * the store, not as literals in the schema.
 *
 * WHY THIS TYPE EXISTS
 *
 *   `enum` and `catalogue` look alike. The question that separates them is who
 *   owns the list. An enum's values are part of what the model *means* — a
 *   lifecycle's states, an outcome, a yes/no. A catalogue's values belong to
 *   the world: job grades, org levels, document kinds, administrative areas —
 *   lists a law or a registry publishes and later amends.
 *
 *   Declaring the second kind as `enum` charges every amendment the price of a
 *   schema change: edit the model, rebuild, redeploy, and where nodes may run
 *   behind, a breaking change. In one real domain a decree added a command post
 *   and the list could not follow, so the post was recorded as a neighbouring
 *   one — and the holder was paid the neighbouring rate. The list was always
 *   data; only its declaration said otherwise.
 *
 *   It also decides who can maintain the list. An administrator can edit rows.
 *   Nobody edits a compiled schema.
 *
 * WHAT THIS TYPE DELIBERATELY DOES NOT DO
 *
 *   It does not prove the row exists. The SDK owns no catalogue store and has
 *   no port to one. Worse, the only copy of the list it *could* check against
 *   would be one compiled into the schema — which is precisely the arrangement
 *   this type exists to end. So it validates the shape (a non-empty key) and
 *   leaves membership to whoever owns the rows, who can answer against live
 *   data.
 */

import { describe, it, expect } from 'vitest'
import { SchemaRegistry } from '../../../src/core/schema/schema-registry.js'
import { collectInstanceDataErrors } from '../../../src/core/graph/validation.js'
import type { EntityTypeDef } from '../../../src/types/index.js'

const TENURE: EntityTypeDef = {
  name: 'OfficeTenure',
  label: 'Chức vụ quản lý',
  properties: [
    { name: 'holderName', type: 'text', required: true },
    { name: 'postName', type: 'catalogue', catalogue: 'unit_post', required: true },
  ],
}

describe('PropertyType: catalogue', () => {
  it('is accepted as a property type', () => {
    const reg = new SchemaRegistry()
    expect(() => reg.defineEntityType(TENURE)).not.toThrow()
  })

  it('refuses a catalogue property that does not name its collection', () => {
    const reg = new SchemaRegistry()
    expect(() =>
      reg.defineEntityType({
        name: 'Missing',
        label: 'Thiếu tên danh mục',
        properties: [{ name: 'postName', type: 'catalogue' }],
      }),
    ).toThrow(/must declare the collection/)
  })

  it('refuses a blank collection name — a text field wearing a costume', () => {
    const reg = new SchemaRegistry()
    expect(() =>
      reg.defineEntityType({
        name: 'Blank',
        label: 'Tên danh mục rỗng',
        properties: [{ name: 'postName', type: 'catalogue', catalogue: '   ' }],
      }),
    ).toThrow(/must declare the collection/)
  })

  it('refuses a collection name that is not a safe identifier', () => {
    const reg = new SchemaRegistry()
    expect(() =>
      reg.defineEntityType({
        name: 'Injected',
        label: 'Tên danh mục không an toàn',
        properties: [{ name: 'postName', type: 'catalogue', catalogue: 'posts; drop table x' }],
      }),
    ).toThrow()
  })

  it('accepts any non-empty key — membership is the store owner’s question', () => {
    // `district_leader` is not listed anywhere in this schema, and that is the
    // point: the schema does not hold the list, so it cannot and must not judge
    // the key. A row added to the catalogue tomorrow has to work without a
    // schema change, which is only true if the schema never checked.
    const errors = collectInstanceDataErrors(
      TENURE,
      { holderName: 'Nguyễn Văn A', postName: 'district_leader' },
      { partial: false },
    )
    expect(errors).toEqual([])
  })

  it('rejects an empty key — a missing choice dressed up as a present one', () => {
    const errors = collectInstanceDataErrors(
      TENURE,
      { holderName: 'Nguyễn Văn A', postName: '   ' },
      { partial: false },
    )
    expect(errors).toHaveLength(1)
  })

  it('rejects a non-string key', () => {
    const errors = collectInstanceDataErrors(
      TENURE,
      { holderName: 'Nguyễn Văn A', postName: 7 },
      { partial: false },
    )
    expect(errors).toHaveLength(1)
  })

  it('still enforces `required` — the type does not soften the obligation', () => {
    const errors = collectInstanceDataErrors(TENURE, { holderName: 'Nguyễn Văn A' }, { partial: false })
    expect(errors).toHaveLength(1)
  })

  it('leaves enum alone — an enum still checks its values against the schema', () => {
    const reg = new SchemaRegistry()
    const lifecycle: EntityTypeDef = {
      name: 'WithBoth',
      label: 'Vừa enum vừa danh mục',
      properties: [
        { name: 'status', type: 'enum', enumValues: ['DRAFT', 'SIGNED'], required: true },
        { name: 'postName', type: 'catalogue', catalogue: 'unit_post', required: true },
      ],
    }
    expect(() => reg.defineEntityType(lifecycle)).not.toThrow()

    // The enum rejects a value it does not list…
    const bad = collectInstanceDataErrors(
      lifecycle,
      { status: 'ISSUED', postName: 'team_leader' },
      { partial: false },
    )
    expect(bad).toHaveLength(1)

    // …while the catalogue on the same entity accepts a key it has never seen.
    const good = collectInstanceDataErrors(
      lifecycle,
      { status: 'SIGNED', postName: 'a_post_added_next_year' },
      { partial: false },
    )
    expect(good).toEqual([])
  })
})

// ── Bề mặt lược đồ ─────────────────────────────────────────────────────────
//
// Nội dung danh mục KHÔNG phải bề mặt — đó chính là điều khiến kiểu này đáng
// có. Nhưng TÊN danh mục thì phải là bề mặt: trỏ một thuộc tính sang danh mục
// khác làm mọi khoá đã ghi mồ côi, đúng cái hại của việc xoá một giá trị enum,
// chỉ là đi vào bằng cửa khác.
describe('catalogue trên bề mặt lược đồ', () => {
  const of = (catalogue: string) => ({
    entityTypes: [
      { name: 'OfficeTenure', label: 't', properties: [{ name: 'postName', type: 'catalogue' as const, catalogue }] },
    ],
    relationshipTypes: [],
  })

  it('mang tên danh mục ra bề mặt', async () => {
    const { schemaSurface } = await import('../../../src/core/schema/surface.js')
    expect(schemaSurface(of('unit_post')).entities.OfficeTenure!.postName!.catalogue).toBe('unit_post')
  })

  it('đổi danh mục nguồn là thay đổi PHÁ VỠ', async () => {
    const { schemaSurface, breakingChanges } = await import('../../../src/core/schema/surface.js')
    const found = breakingChanges(schemaSurface(of('unit_post')), schemaSurface(of('other_posts')))
    expect(found).toHaveLength(1)
    expect(found[0]!.kind).toBe('CATALOGUE_CHANGED')
  })

  it('thêm hay bớt HÀNG trong danh mục thì bề mặt không đổi — không có gì để phá vỡ', async () => {
    const { schemaSurface, breakingChanges } = await import('../../../src/core/schema/surface.js')
    // Bề mặt không giữ nội dung, nên hai lược đồ giống hệt nhau dù danh mục
    // ngoài kia vừa thêm mười hàng. Đây là điều enum không làm được.
    expect(breakingChanges(schemaSurface(of('unit_post')), schemaSurface(of('unit_post')))).toEqual([])
  })
})
