import { describe, it, expect } from 'vitest'
import { promoteDraftToClientRule, promoteDraftToTemplateRule } from './service.js'
import type { RuleDraft } from './types.js'

// Fake store implementing only what promote touches — tests the service governance
// logic (gates, versioning) without a DB. Cổng author≠approver ĐÃ GỠ —
// tự-duyệt được phép; governance = quyền `rules.manage` ở app-layer.
function fakeStore(draft: RuleDraft | null, existingVersions = 0) {
  const inserted: any[] = [], updated: any[] = []
  const store: any = {
    getDraft: async () => draft,
    nextRuleVersion: async () => existingVersions + 1,
    insertRuleVersion: async (r: any) => { inserted.push(r) },
    updateDraft: async (id: string, patch: any) => { updated.push({ id, patch }) },
  }
  return { store, inserted, updated }
}

const draft = (over: Partial<RuleDraft> = {}): RuleDraft => ({
  id: 'd1', nl: 'nợ 111 có 511', target: { kind: 'client', id: 'client-X' }, status: 'validated',
  ruleId: 'R-CUST-1', appliesTo: 'AccountBalance',
  // `finding` is part of a promotable rule, not decoration: a rule that fires must be able to state what it
  // found. See `assertStatable` in service.ts — 48 of 167 active rules once shipped without it.
  spec: {
    id: 'R-CUST-1', on: 'AccountBalance', severity: 'warning',
    expr: { op: 'lit', value: true },
    finding: { message: 'TK {accountCode} vi phạm quy tắc kiểm thử' },
  },
  author: 'alice', ...over,
})

describe('promoteDraftToClientRule', () => {
  it('promotes a validated client draft → active rule_version(owner=client)', async () => {
    const { store, inserted, updated } = fakeStore(draft())
    expect(await promoteDraftToClientRule(store, 'd1', 'bob')).toEqual({ ruleId: 'R-CUST-1', version: 1 })
    expect(inserted[0]).toMatchObject({ ownerScope: 'client', ownerId: 'client-X', ruleId: 'R-CUST-1', version: 1, approvedBy: 'bob', authoredBy: 'alice', severity: 'warning' })
    expect(inserted[0].contentHash).toMatch(/^[0-9a-f]{64}$/)
    expect(updated[0]).toEqual({ id: 'd1', patch: { status: 'active', promotedTo: 'R-CUST-1@1' } })
  })
  it('bumps version when rule_id already exists for the client', async () => {
    const { store } = fakeStore(draft(), 2)
    expect((await promoteDraftToClientRule(store, 'd1', 'bob')).version).toBe(3)
  })
  it('cho phép tự-duyệt (author === approver)', async () => {
    const { store, inserted } = fakeStore(draft({ author: 'alice' }))
    await promoteDraftToClientRule(store, 'd1', 'alice')
    expect(inserted[0]).toMatchObject({ authoredBy: 'alice', approvedBy: 'alice' })
  })
  it('rejects non-client target (template promote = M3)', async () => {
    const { store } = fakeStore(draft({ target: { kind: 'template', id: 't1' } }))
    await expect(promoteDraftToClientRule(store, 'd1', 'bob')).rejects.toThrow(/client/)
  })
  it('rejects not-promotable status', async () => {
    const { store } = fakeStore(draft({ status: 'waiting' }))
    await expect(promoteDraftToClientRule(store, 'd1', 'bob')).rejects.toThrow(/sẵn sàng/)
  })
  it('rejects missing spec / ruleId', async () => {
    await expect(promoteDraftToClientRule(fakeStore(draft({ spec: undefined })).store, 'd1', 'bob')).rejects.toThrow(/spec/)
    await expect(promoteDraftToClientRule(fakeStore(draft({ ruleId: null })).store, 'd1', 'bob')).rejects.toThrow(/ruleId/)
  })
  it('rejects unknown draft', async () => {
    await expect(promoteDraftToClientRule(fakeStore(null).store, 'd1', 'bob')).rejects.toThrow(/không tồn tại/)
  })
  // REGRESSION: căn cứ pháp lý (target.cite) PHẢI theo luật sang rule_version — nếu không, luật
  // chạy mất nguồn và màn Thư viện quy định báo "không nguồn" (đã xảy ra với 82 luật active).
  it('mang target.cite → rule_version.cite khi promote', async () => {
    const cite = { doc: 'TT200-2014', at: 'Điều 18 khoản 1', kind: 'standard' }
    const { store, inserted } = fakeStore(draft({ target: { kind: 'client', id: 'client-X', cite, citeReviewed: true } }))
    await promoteDraftToClientRule(store, 'd1', 'bob')
    expect(inserted[0]).toMatchObject({ cite, citeReviewed: true })
  })
  it('cite vắng → null (không ném lỗi)', async () => {
    const { store, inserted } = fakeStore(draft())
    await promoteDraftToClientRule(store, 'd1', 'bob')
    expect(inserted[0].cite).toBeNull()
  })
})

function fakeTemplateStore(draft: RuleDraft, opts: { latest?: any; members?: any[] } = {}) {
  const inserted: any[] = [], tvCreated: any[] = [], membersAdded: any[] = [], updated: any[] = []
  const store: any = {
    getDraft: async () => draft,
    getTemplateOwner: async () => ({ scope: 'firm' as const, id: 'firm-1' }),
    nextRuleVersion: async () => 1,
    insertRuleVersion: async (r: any) => { inserted.push(r) },
    latestTemplateVersion: async () => opts.latest ?? null,
    getTemplateMembers: async () => opts.members ?? [],
    createDraftTemplateVersion: async (t: string, v: number, by: string) => { tvCreated.push({ v, by }) },
    addTemplateMember: async (_t: string, v: number, rid: string, rv: number) => { membersAdded.push({ v, rid, rv }) },
    updateDraft: async (id: string, patch: any) => { updated.push({ id, patch }) },
  }
  return { store, inserted, tvCreated, membersAdded, updated }
}

const tplDraft = (over: Partial<RuleDraft> = {}): RuleDraft =>
  ({ ...draft({ target: { kind: 'template', id: 'tpl-1' }, ruleId: 'R-SEG-A' }), ...over })

describe('promoteDraftToTemplateRule (loại C)', () => {
  it('no existing version → create draft tpl v1 + firm rule_version + member', async () => {
    const f = fakeTemplateStore(tplDraft())
    const res = await promoteDraftToTemplateRule(f.store, 'd1', 'bob')
    expect(res).toEqual({ ruleId: 'R-SEG-A', ruleVersion: 1, templateVersion: 1 })
    expect(f.inserted[0]).toMatchObject({ ownerScope: 'firm', ownerId: 'firm-1', ruleId: 'R-SEG-A' })
    expect(f.tvCreated[0]).toMatchObject({ v: 1 })
    expect(f.membersAdded.at(-1)).toEqual({ v: 1, rid: 'R-SEG-A', rv: 1 })
  })

  it('latest published v1 → bump to draft v2, copy v1 members + add new', async () => {
    const f = fakeTemplateStore(tplDraft(), { latest: { version: 1, status: 'published' }, members: [{ ruleId: 'R-OLD', ruleVersion: 1 }] })
    const res = await promoteDraftToTemplateRule(f.store, 'd1', 'bob')
    expect(res.templateVersion).toBe(2)
    expect(f.tvCreated[0]).toMatchObject({ v: 2 })
    expect(f.membersAdded.map((m) => m.rid)).toEqual(['R-OLD', 'R-SEG-A']) // copied + new
  })

  it('latest is an open DRAFT v2 → reuse it (no new version)', async () => {
    const f = fakeTemplateStore(tplDraft(), { latest: { version: 2, status: 'draft' } })
    const res = await promoteDraftToTemplateRule(f.store, 'd1', 'bob')
    expect(res.templateVersion).toBe(2)
    expect(f.tvCreated).toHaveLength(0) // reused, not created
  })

  it('rejects non-template target', async () => {
    await expect(promoteDraftToTemplateRule(fakeTemplateStore(tplDraft({ target: { kind: 'client', id: 'x' } })).store, 'd1', 'bob')).rejects.toThrow(/template/)
  })
})

describe('a rule must be able to state what it found', () => {
  // A rule without `finding` compiles and fires, but the evaluator can emit neither a message nor an amount:
  // it reports "something is wrong here" with no what and no how much. Measured on a real registry, 48 of
  // 167 active rules were in that state — including ledger-vs-subledger, which fired `critical` on an
  // account off by 1.9 billion and surfaced with exposure 0, indistinguishable from a rounding error.
  //
  // The gate sits at promote, not in the schema: a rule under test or mid-authoring may legitimately lack a
  // finding; a rule that starts running on real books may not.
  it('rejects a promote when finding.message is missing', async () => {
    const spec = { id: 'R-X', on: 'AccountBalance', expr: { op: 'lit', value: true } }
    await expect(promoteDraftToClientRule(fakeStore(draft({ spec })).store, 'd1', 'bob'))
      .rejects.toThrow(/finding\.message/)
  })

  it('rejects a blank message just as firmly as a missing one', async () => {
    const spec = { id: 'R-X', on: 'AccountBalance', expr: { op: 'lit', value: true }, finding: { message: '   ' } }
    await expect(promoteDraftToClientRule(fakeStore(draft({ spec })).store, 'd1', 'bob'))
      .rejects.toThrow(/finding\.message/)
  })
})
