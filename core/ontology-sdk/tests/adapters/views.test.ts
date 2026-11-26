/**
 * K6 — generated operator views.
 *
 * Business properties live in jsonb, so without these the person diagnosing a
 * stuck record at 2am cannot use plain SQL. Two details here were each learned
 * by being wrong, and both are pinned below: `security_invoker`, without which
 * the view is a hole through row-level security; and DROP-before-CREATE,
 * without which the first property rename breaks the migration.
 */
import { describe, it, expect } from 'vitest'
import { buildViewsDDL, buildViewsSQL } from '../../src/index.js'
import type { OntologySchema } from '../../src/types/index.js'

const schema: OntologySchema = {
  entityTypes: [
    {
      name: 'StaffMember',
      label: 'Member',
      properties: [
        { name: 'fullName', type: 'text' },
        { name: 'dateOfBirth', type: 'date' },
        { name: 'headcount', type: 'number' },
        { name: 'status', type: 'enum', enumValues: ['ACTIVE', 'RELEASED'] },
        { name: 'communeCode', type: 'text' },
      ],
    },
  ],
  relationshipTypes: [
    { name: 'servesIn', from: 'StaffMember', to: 'StaffUnit', cardinality: 'N..1', directed: true },
  ],
}

const sql = () => buildViewsDDL(schema).join('\n')

describe('K6 · one flat view per entity', () => {
  it('names it after the entity, in snake_case', () => {
    expect(sql()).toContain('CREATE VIEW :schema.v_staff_member')
  })

  it('lifts every property out of jsonb as its own column', () => {
    const out = sql()
    expect(out).toContain("i.data->>'fullName' AS full_name")
    expect(out).toContain("i.data->>'communeCode' AS commune_code")
  })

  it('casts by declared type, so ordering and comparison behave', () => {
    const out = sql()
    expect(out).toContain("(i.data->>'dateOfBirth')::date AS date_of_birth")
    expect(out).toContain("(i.data->>'headcount')::numeric AS headcount")
    // enum and text stay textual
    expect(out).toContain("i.data->>'status' AS status")
  })

  it('carries provenance and timestamps through', () => {
    for (const col of ['i.source_ref', 'i.confirmed_by', 'i.confirmed_at', 'i.created_at', 'i.updated_at']) {
      expect(sql()).toContain(col)
    }
  })

  it('filters to the entity type', () => {
    expect(sql()).toContain("WHERE i.entity_type = 'StaffMember'")
  })
})

describe('K6 · security_invoker is not optional', () => {
  it('every view declares it', () => {
    const creates = buildViewsDDL(schema).filter((s) => s.startsWith('CREATE VIEW'))
    expect(creates.length).toBeGreaterThan(0)
    for (const stmt of creates) {
      // Without this the view runs as its owner, who bypasses row-level
      // security — every tenant's rows, through a view the app trusts.
      expect(stmt).toContain('WITH (security_invoker = true)')
    }
  })
})

describe('K6 · re-runnable', () => {
  it('drops before creating, so a renamed property does not wedge the migration', () => {
    const out = buildViewsDDL(schema)
    const dropAt = out.findIndex((s) => s.includes('DROP VIEW IF EXISTS :schema.v_staff_member'))
    const createAt = out.findIndex((s) => s.includes('CREATE VIEW :schema.v_staff_member'))
    expect(dropAt).toBeGreaterThanOrEqual(0)
    expect(dropAt).toBeLessThan(createAt)
    expect(out[dropAt]).toContain('CASCADE')
  })

  it('produces identical output for identical input', () => {
    expect(buildViewsDDL(schema)).toEqual(buildViewsDDL(schema))
  })
})

describe('K6 · relationship views', () => {
  it('names both endpoints after their entity types', () => {
    const out = sql()
    expect(out).toContain('CREATE VIEW :schema.v_rel_serves_in')
    expect(out).toContain('e.from_id AS staff_member_id')
    expect(out).toContain('e.to_id AS staff_unit_id')
    expect(out).toContain("WHERE e.rel = 'servesIn'")
  })
})

describe('K6 · expression indexes', () => {
  it('none by default — which properties are hot is the app\'s knowledge', () => {
    expect(buildViewsDDL(schema).some((s) => s.startsWith('CREATE INDEX'))).toBe(false)
  })

  it('indexes exactly the properties named, scoped to the entity type', () => {
    const out = buildViewsDDL(schema, { indexed: ['communeCode', 'status'] })
      .filter((s) => s.startsWith('CREATE INDEX'))
    expect(out).toHaveLength(2)
    expect(out.join('\n')).toContain("((data->>'communeCode'))")
    expect(out.join('\n')).toContain("WHERE entity_type = 'StaffMember'")
  })

  it('ignores a name no entity declares', () => {
    const out = buildViewsDDL(schema, { indexed: ['nope'] }).filter((s) => s.startsWith('CREATE INDEX'))
    expect(out).toHaveLength(0)
  })
})

describe('K6 · target schema', () => {
  it('defaults to a placeholder, so one file serves many tenants', () => {
    expect(sql()).toContain(':schema.instances')
  })

  it('takes a concrete schema when given one', () => {
    expect(buildViewsDDL(schema, { schema: 't_acme' }).join('\n')).toContain('t_acme.instances')
  })

  it('refuses an unsafe schema identifier', () => {
    expect(() => buildViewsDDL(schema, { schema: 'evil"; DROP TABLE x; --' })).toThrow()
  })
})

describe('K6 · file form', () => {
  it('carries a do-not-edit header', () => {
    const file = buildViewsSQL(schema)
    expect(file).toContain('DO NOT EDIT BY HAND')
    expect(file).toContain('CREATE VIEW')
  })
})
