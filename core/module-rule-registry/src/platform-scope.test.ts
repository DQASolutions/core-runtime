// Chủ sở hữu `platform` — base ruleset do DQA sở hữu, firm KẾ THỪA (inherit-model).
//
// Bất biến then chốt: một member trỏ đúng luật của ĐÚNG CHỦ. Từ migration 007, chủ ấy do member
// tự khai (`rule_owner_scope/id`) chứ không suy từ chủ của template — nhờ vậy bộ luật của hãng
// chứa được luật của DQA. getResolveInputs (pg-store) và promoteDraftToTemplateRule (service)
// phải nhất quán về chủ; nếu lệch, luật vừa promote sẽ không bao giờ resolve ra.
import { describe, it, expect } from 'vitest'
import type { Queryable } from './db.js'
import { PgRegistryStore } from './pg-store.js'
import { PLATFORM_ID, LAYER } from './types.js'
import { promoteDraftToTemplateRule } from './service.js'
import type { RegistryStore } from './store.js'

/** Ghi lại (sql, params) của MỌI truy vấn để khẳng định join đúng cặp owner. */
function spyDb(rowsFor: (sql: string, p: unknown[]) => any[]): { db: Queryable; calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = []
  return {
    calls,
    db: {
      async query(text: string, params: unknown[] = []) {
        calls.push([text, params])
        return { rows: rowsFor(text, params) }
      },
    },
  }
}

const platformSub = (sql: string): any[] => {
  if (/client_subscription/.test(sql)) {
    return [{ template_id: 'tpl-base', pinned_version: 1, channel: 'stable', layer_rank: LAYER.base,
              owner_scope: 'platform', owner_id: PLATFORM_ID }]
  }
  if (/rule_template_member/.test(sql)) return [{ rule_id: 'R-CASH', version: 1, ir: {} }]
  if (/owner_scope = 'client'/.test(sql)) return []
  if (/rule_override/.test(sql)) return []
  return []
}

describe('getResolveInputs — template thuộc platform', () => {
  it('join member theo chủ do MEMBER khai, không phải chủ template và không phải firm của khách', async () => {
    const { db, calls } = spyDb(platformSub)
    const { candidates } = await new PgRegistryStore(db).getResolveInputs('client-X', '2026-03-31')

    const memberCall = calls.find(([sql]) => /rule_template_member/.test(sql))!
    // Chủ của luật lấy TỪ MEMBER, không từ template và không từ hãng của khách.
    expect(memberCall[0]).toMatch(/rv\.owner_scope = m\.rule_owner_scope AND rv\.owner_id = m\.rule_owner_id/)
    expect(memberCall[1]).toEqual(['tpl-base', 1, '2026-03-31'])  // asOf → lọc hiệu lực (N5)

    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ ruleId: 'R-CASH', layer: LAYER.base })
  })

  it('luật base của platform KHÔNG bị nhầm với luật cùng rule_id của một firm', async () => {
    // firm-1 cũng có R-CASH v9 (di sản copy-model). Phép lọc nằm ở JOIN theo chủ do member khai.
    //
    // Fake db thi hành đúng ngữ nghĩa ấy (join trên m.rule_owner_*), nên khẳng định về SQL text
    // bên dưới KHÔNG thừa: nếu ai đó quay lại join theo chủ của TEMPLATE, fake vẫn xanh còn
    // Postgres thì trả nhầm luật. Text-assert là chốt chặn cho chính chỗ đó.
    const MEMBERS = [{ rule_id: 'R-CASH', rule_version: 1, rule_owner_scope: 'platform', rule_owner_id: PLATFORM_ID }]
    const VERSIONS = [
      { rule_id: 'R-CASH', version: 1, owner_scope: 'platform', owner_id: PLATFORM_ID, ir: { src: 'platform' } },
      { rule_id: 'R-CASH', version: 9, owner_scope: 'firm', owner_id: 'firm-1', ir: { src: 'firm-legacy' } },
    ]
    const { db, calls } = spyDb((sql) => {
      if (/client_subscription/.test(sql)) {
        return [{ template_id: 'tpl-base', pinned_version: 1, channel: 'stable', layer_rank: LAYER.base,
                  owner_scope: 'platform', owner_id: PLATFORM_ID }]
      }
      if (/rule_template_member/.test(sql)) {
        return MEMBERS.flatMap((m) => VERSIONS
          .filter((rv) => rv.owner_scope === m.rule_owner_scope && rv.owner_id === m.rule_owner_id
                       && rv.rule_id === m.rule_id && rv.version === m.rule_version)
          .map((rv) => ({ rule_id: rv.rule_id, version: rv.version, ir: rv.ir })))
      }
      return []
    })
    const { candidates } = await new PgRegistryStore(db).getResolveInputs('client-X', '2026-03-31')
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ version: 1, ir: { src: 'platform' } })
    expect(calls.find(([sql]) => /rule_template_member/.test(sql))![0])
      .toMatch(/rv\.owner_scope = m\.rule_owner_scope/)
  })

  it('N7 — bộ luật của HÃNG chứa luật của DQA: resolve ra luật platform', async () => {
    // Đây là thứ trước migration 007 KHÔNG THỂ xảy ra: template chủ `firm`, member trỏ luật `platform`.
    const MEMBERS = [
      { rule_id: 'R-CASH', rule_version: 1, rule_owner_scope: 'platform', rule_owner_id: PLATFORM_ID },
      { rule_id: 'R-NOI-BO', rule_version: 2, rule_owner_scope: 'firm', rule_owner_id: 'firm-1' },
    ]
    const VERSIONS = [
      { rule_id: 'R-CASH', version: 1, owner_scope: 'platform', owner_id: PLATFORM_ID, ir: { src: 'thư viện DQA' } },
      { rule_id: 'R-NOI-BO', version: 2, owner_scope: 'firm', owner_id: 'firm-1', ir: { src: 'kệ của hãng' } },
    ]
    const { db } = spyDb((sql) => {
      if (/client_subscription/.test(sql)) {
        return [{ template_id: 'tpl-firm', pinned_version: 1, channel: 'stable', layer_rank: LAYER.segment,
                  owner_scope: 'firm', owner_id: 'firm-1' }]
      }
      if (/rule_template_member/.test(sql)) {
        return MEMBERS.flatMap((m) => VERSIONS
          .filter((rv) => rv.owner_scope === m.rule_owner_scope && rv.owner_id === m.rule_owner_id
                       && rv.rule_id === m.rule_id && rv.version === m.rule_version)
          .map((rv) => ({ rule_id: rv.rule_id, version: rv.version, ir: rv.ir })))
      }
      return []
    })
    const { candidates } = await new PgRegistryStore(db).getResolveInputs('client-X', '2026-03-31')
    expect(candidates.map((c) => c.ruleId).sort()).toEqual(['R-CASH', 'R-NOI-BO'])
    expect(candidates.find((c) => c.ruleId === 'R-CASH')!.ir).toEqual({ src: 'thư viện DQA' })
  })
})

describe('promoteDraftToTemplateRule — luật member theo chủ của template', () => {
  const draft = {
    id: 'd1', nl: 'tiền mặt không âm', target: { kind: 'template' as const, id: 'tpl-base' },
    status: 'validated' as const, ruleId: 'R-CASH', appliesTo: 'AccountBalance',
    spec: { on: 'AccountBalance', id: 'R-CASH', expr: {}, severity: 'critical', finding: { message: 'TK {accountCode} vi phạm' } }, author: 'u-author',
  }

  const fakeStore = (ownerScope: 'platform' | 'firm', ownerId: string, inserted: any[]) => ({
    getDraft: async () => draft,
    getTemplateOwner: async () => ({ scope: ownerScope, id: ownerId }),
    nextRuleVersion: async () => 1,
    insertRuleVersion: async (row: any) => { inserted.push(row) },
    latestTemplateVersion: async () => ({ version: 1, status: 'draft' }),
    getTemplateMembers: async () => [],
    createDraftTemplateVersion: async () => {},
    addTemplateMember: async () => {},
    updateDraft: async () => {},
  }) as unknown as RegistryStore

  it('template của platform → rule_version owner_scope=platform', async () => {
    const inserted: any[] = []
    await promoteDraftToTemplateRule(fakeStore('platform', PLATFORM_ID, inserted), 'd1', 'u-approver')
    expect(inserted[0]).toMatchObject({ ownerScope: 'platform', ownerId: PLATFORM_ID, ruleId: 'R-CASH' })
  })

  it('template của firm → rule_version owner_scope=firm (không đổi hành vi cũ)', async () => {
    const inserted: any[] = []
    await promoteDraftToTemplateRule(fakeStore('firm', 'firm-1', inserted), 'd1', 'u-approver')
    expect(inserted[0]).toMatchObject({ ownerScope: 'firm', ownerId: 'firm-1' })
  })
})

// ── N7: CHỦ CỦA LUẬT ≠ CHỦ CỦA TEMPLATE ────────────────────────────────────────────────────
// Đây là mắt xích mở ra mô hình sản phẩm: DQA sở hữu tri thức (thư viện), hãng sở hữu dịch vụ
// (chọn lắp luật nào cho khách nào). Trước migration 007, chủ của luật được SUY từ chủ của
// template, nên bộ luật của hãng vĩnh viễn không chứa nổi một luật nào của DQA.
describe('member mang chủ của LUẬT, độc lập chủ của template (N7)', () => {
  const PF = { scope: 'platform' as const, id: PLATFORM_ID }

  it('mở version nháp: chép member GIỮ NGUYÊN chủ của từng luật', async () => {
    const added: any[] = []
    const store = {
      getDraft: async () => ({
        id: 'd1', nl: 'x', target: { kind: 'template' as const, id: 'tpl-firm' }, status: 'validated' as const,
        ruleId: 'R-RIENG', appliesTo: 'A', spec: { on: 'A', id: 'R-RIENG', expr: {}, severity: 'info', finding: { message: 'vi phạm riêng của khách' } }, author: 'u1',
      }),
      getTemplateOwner: async () => ({ scope: 'firm' as const, id: 'firm-1' }),
      nextRuleVersion: async () => 1,
      insertRuleVersion: async () => {},
      // version 1 đã PHÁT HÀNH ⇒ promote phải mở version 2 và chép member sang.
      latestTemplateVersion: async () => ({ version: 1, status: 'published' }),
      getTemplateMembers: async () => [
        // luật của DQA, hãng lắp vào bộ của mình
        { ruleId: 'R-CASH-NEVER-NEGATIVE', ruleVersion: 3, ruleOwner: PF },
        // luật do chính hãng soạn
        { ruleId: 'R-NOI-BO', ruleVersion: 1, ruleOwner: { scope: 'firm' as const, id: 'firm-1' } },
      ],
      createDraftTemplateVersion: async () => {},
      addTemplateMember: async (_t: string, v: number, rid: string, rv: number, owner?: any) =>
        { added.push({ v, rid, rv, owner }) },
      updateDraft: async () => {},
    } as unknown as RegistryStore

    await promoteDraftToTemplateRule(store, 'd1', 'u2')

    const carried = added.find((a) => a.rid === 'R-CASH-NEVER-NEGATIVE')
    expect(carried.owner).toEqual(PF)   // ← KHÔNG bị viết lại thành firm-1
    expect(added.find((a) => a.rid === 'R-NOI-BO').owner).toEqual({ scope: 'firm', id: 'firm-1' })
    // luật mới promote thuộc chủ của template (hãng tự soạn) — mặc định, không truyền owner
    expect(added.find((a) => a.rid === 'R-RIENG').owner).toBeUndefined()
  })
})

// ── N5: hiệu lực theo ngày áp cho MỌI luật, không riêng luật của khách ──────────────────────
// Một check trích từ Thông tư đã bị thay thế phải tự ngừng cho kỳ sau ngày hết hiệu lực.
// Nguồn của cặp ngày là vòng đời VĂN BẢN; registry chỉ thấy hai cột ngày trên rule_version.
describe('hiệu lực theo ngày cho luật trong template (N5)', () => {
  const memberSql = (rows: any[]) => (sql: string, p: unknown[]) => {
    if (/client_subscription/.test(sql)) {
      return [{ template_id: 'tpl-base', pinned_version: 1, channel: 'stable', layer_rank: LAYER.base,
                owner_scope: 'platform', owner_id: PLATFORM_ID }]
    }
    if (/rule_template_member/.test(sql)) {
      const asOf = p[2] as string   // ← resolve truyền asOf xuống join
      return rows.filter((r) => (!r.from || r.from <= asOf) && (!r.to || r.to >= asOf))
                 .map((r) => ({ rule_id: r.rule_id, version: 1, ir: {} }))
    }
    return []
  }

  const RULES = [
    { rule_id: 'R-CON-HIEU-LUC', from: null, to: null },
    { rule_id: 'R-TT78-HET-HAN', from: null, to: '2015-08-06' },   // bị TT96 thay thế
    { rule_id: 'R-TT96-CHUA-HIEU-LUC', from: '2015-08-06', to: null },
  ]

  it('kỳ TRƯỚC ngày văn bản hết hiệu lực: luật cũ vẫn chạy, luật mới chưa', async () => {
    const { db } = spyDb(memberSql(RULES))
    const { candidates } = await new PgRegistryStore(db).getResolveInputs('c1', '2015-03-31')
    expect(candidates.map((c) => c.ruleId).sort()).toEqual(['R-CON-HIEU-LUC', 'R-TT78-HET-HAN'])
  })

  it('kỳ SAU ngày văn bản hết hiệu lực: luật cũ TỰ NGỪNG, không cần ai gỡ khỏi template', async () => {
    const { db, calls } = spyDb(memberSql(RULES))
    const { candidates } = await new PgRegistryStore(db).getResolveInputs('c1', '2026-03-31')
    expect(candidates.map((c) => c.ruleId).sort()).toEqual(['R-CON-HIEU-LUC', 'R-TT96-CHUA-HIEU-LUC'])
    // asOf phải thực sự đi vào truy vấn member — nếu không, fake trên vẫn xanh mà SQL thì không lọc.
    const [sql, p] = calls.find(([s]) => /rule_template_member/.test(s))!
    expect(sql).toMatch(/rv\.effective_from IS NULL OR rv\.effective_from <= \$3/)
    expect(p[2]).toBe('2026-03-31')
  })
})
