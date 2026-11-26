import { describe, it, expect } from 'vitest'
import { matchesTemplate, suggestTemplates, type TemplateCriteria } from './suggest.js'

const tpl = (key: string, appliesWhen: TemplateCriteria['appliesWhen'], layerRank: number): TemplateCriteria =>
  ({ templateId: key, key, appliesWhen, layerRank })

describe('matchesTemplate', () => {
  it('null/empty applies_when → matches everyone (base)', () => {
    expect(matchesTemplate(null, { business_type: 'trading' })).toBe(true)
    expect(matchesTemplate({}, {})).toBe(true)
  })
  it('single-key: value in allowed list matches', () => {
    expect(matchesTemplate({ business_type: ['manufacturing', 'mixed'] }, { business_type: 'manufacturing' })).toBe(true)
    expect(matchesTemplate({ business_type: ['manufacturing'] }, { business_type: 'trading' })).toBe(false)
  })
  it('missing/null client attr for a required key → no match', () => {
    expect(matchesTemplate({ business_type: ['manufacturing'] }, {})).toBe(false)
    expect(matchesTemplate({ business_type: ['manufacturing'] }, { business_type: null })).toBe(false)
  })
  it('multi-key = AND (all must match)', () => {
    const w = { business_type: ['manufacturing'], profile: ['tt200'] }
    expect(matchesTemplate(w, { business_type: 'manufacturing', profile: 'tt200' })).toBe(true)
    expect(matchesTemplate(w, { business_type: 'manufacturing', profile: 'tt133' })).toBe(false)
  })
  it('empty array for a key = no constraint on that key', () => {
    expect(matchesTemplate({ business_type: [] }, { business_type: 'anything' })).toBe(true)
  })
})

describe('suggestTemplates', () => {
  it('returns matching templates sorted by layer_rank (base first)', () => {
    const templates = [
      tpl('vat-export', { business_type: ['trading'] }, 20),
      tpl('base', null, 0),
      tpl('manufacturing', { business_type: ['manufacturing'] }, 10),
    ]
    // a manufacturing client
    expect(suggestTemplates(templates, { business_type: 'manufacturing' }).map((t) => t.key)).toEqual(['base', 'manufacturing'])
    // a trading client
    expect(suggestTemplates(templates, { business_type: 'trading' }).map((t) => t.key)).toEqual(['base', 'vat-export'])
    // unclassified client → only base
    expect(suggestTemplates(templates, {}).map((t) => t.key)).toEqual(['base'])
  })
})
