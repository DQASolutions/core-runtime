import { describe, it, expect } from 'vitest'
import { resolveRuleSet, canonicalStringify } from './resolve.js'
import { LAYER, type ScopedRule } from './types.js'

type IR = Record<string, unknown>

const base = (ruleId: string, version: number, ir: IR = {}): ScopedRule<IR> => ({
  ruleId, version, ir, layer: LAYER.base, source: { kind: 'base-template', ownerId: 'base', templateVersion: 1 },
})
const segment = (ruleId: string, version: number, ir: IR = {}): ScopedRule<IR> => ({
  ruleId, version, ir, layer: LAYER.segment, source: { kind: 'segment-template', ownerId: 'seg', templateVersion: 1 },
})
const client = (ruleId: string, version: number, ir: IR = {}): ScopedRule<IR> => ({
  ruleId, version, ir, layer: LAYER.client, source: { kind: 'client', ownerId: 'X' },
})

describe('resolveRuleSet — M1 single-layer + overrides', () => {
  it('base only → all rules pass through', () => {
    const { rules, manifest } = resolveRuleSet<IR>({
      candidates: [base('R-A', 1), base('R-B', 1)],
      overrides: [],
    })
    expect(rules.map((r) => r.ruleId)).toEqual(['R-A', 'R-B'])
    expect(manifest.rules).toHaveLength(2)
    expect(manifest.overridesApplied).toEqual([])
  })

  it('client rule SHADOWS base by rule_id (higher layer wins)', () => {
    const { rules } = resolveRuleSet<IR>({
      candidates: [base('R-A', 1, { t: 20 }), client('R-A', 3, { t: 5 })],
      overrides: [],
    })
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ ruleId: 'R-A', version: 3, ir: { t: 5 }, source: { kind: 'client' } })
  })

  it('multi-layer precedence: client > segment > base for the same rule_id', () => {
    const { rules } = resolveRuleSet<IR>({
      candidates: [base('R-A', 1, { L: 'base' }), segment('R-A', 2, { L: 'seg' }), client('R-A', 3, { L: 'client' })],
      overrides: [],
    })
    expect(rules).toHaveLength(1)
    expect(rules[0]).toMatchObject({ version: 3, ir: { L: 'client' }, source: { kind: 'client' } })
  })

  it('segment shadows base when no client rule (order-independent)', () => {
    const { rules } = resolveRuleSet<IR>({
      candidates: [segment('R-A', 2, { L: 'seg' }), base('R-A', 1, { L: 'base' })], // segment listed first
      overrides: [],
    })
    expect(rules[0]).toMatchObject({ version: 2, source: { kind: 'segment-template' } })
  })

  it('distinct rule_ids across layers all survive', () => {
    const { rules } = resolveRuleSet<IR>({
      candidates: [base('R-A', 1), segment('R-B', 1), client('R-C', 1)],
      overrides: [],
    })
    expect(rules.map((r) => r.ruleId)).toEqual(['R-A', 'R-B', 'R-C'])
  })

  it('empty candidates → empty result + empty manifest', () => {
    const { rules, manifest } = resolveRuleSet<IR>({ candidates: [], overrides: [] })
    expect(rules).toEqual([])
    expect(manifest.rules).toEqual([])
    expect(manifest.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  // §12.2: KHÔNG có động từ "tắt luật". Tập luật resolve ra LUÔN đầy đủ; "không áp" = miễn trừ
  // ở tầng kết quả (finding_waiver, app-layer) và ĐỂ LẠI DẤU. Trước đây `enabled=false` làm luật
  // rơi khỏi tập lúc resolve ⇒ kết quả im lặng ⇒ trượt bất biến TÁI LẬP (N6).
  it('không có nhánh nào làm luật rơi khỏi tập', () => {
    const { rules } = resolveRuleSet<IR>({
      candidates: [base('R-A', 1), base('R-B', 1)],
      overrides: [{ ruleId: 'R-B', scope: 'client', reason: 'không áp cho khách này' }],
    })
    expect(rules.map((r) => r.ruleId)).toEqual(['R-A', 'R-B'])
  })

  it('params: vặn ngưỡng — IR KHÔNG bị chạm (content_hash sạch)', () => {
    const ir = { threshold: 20_000_000 }
    const { rules, manifest, params } = resolveRuleSet<IR>({
      candidates: [base('R-A', 1, ir as any)],
      overrides: [{ ruleId: 'R-A', scope: 'client', params: { 'vat-input-accum-warn': 5_000_000 }, reason: 'ngưỡng riêng' }],
    })
    expect(rules[0].ir).toEqual(ir)                                  // IR nguyên vẹn
    expect(params).toEqual({ 'vat-input-accum-warn': 5_000_000 })
    expect(manifest.overridesApplied).toEqual([{ ruleId: 'R-A', kind: 'params', scope: 'client' }])
  })

  it('client đè firm bất kể thứ tự hàng trả về (OVERRIDE_RANK)', () => {
    const { params } = resolveRuleSet<IR>({
      candidates: [base('R-A', 1)],
      overrides: [
        { ruleId: 'R-A', scope: 'client', params: { k: 2 }, reason: 'khách' },
        { ruleId: 'R-A', scope: 'firm', params: { k: 1 }, reason: 'hãng' },
      ],
    })
    expect(params).toEqual({ k: 2 })
  })

  // `patch` chỉ còn dùng cho khoá CẤP MỘT của RuleIR (thực tế: severity). Nó là shallow merge,
  // KHÔNG chạm nổi một `lit` nằm sâu trong cây `expr` — vặn ngưỡng phải đi qua `params` (§A.3).
  it('patch shallow-merge khoá cấp một (severity) + ghi dấu', () => {
    const { rules, manifest } = resolveRuleSet<IR>({
      candidates: [base('R-A', 1, { severity: 'critical', unit: 'VND' } as any)],
      overrides: [{ ruleId: 'R-A', scope: 'client', patch: { severity: 'warning' }, reason: 'hạ mức' }],
    })
    expect(rules[0].ir).toEqual({ severity: 'warning', unit: 'VND' })
    expect(manifest.overridesApplied).toEqual([{ ruleId: 'R-A', kind: 'patched', scope: 'client' }])
  })

  it('override for a rule not present is ignored', () => {
    const { rules, manifest } = resolveRuleSet<IR>({
      candidates: [base('R-A', 1)],
      overrides: [{ ruleId: 'R-NOPE', scope: 'client', reason: 'luật không tồn tại' }],
    })
    expect(rules.map((r) => r.ruleId)).toEqual(['R-A'])
    expect(manifest.overridesApplied).toEqual([])
  })

  it('manifest hash is deterministic regardless of candidate order (reproducible lockfile)', () => {
    const a = resolveRuleSet<IR>({ candidates: [base('R-A', 1, { t: 1 }), base('R-B', 2, { t: 2 })], overrides: [] })
    const b = resolveRuleSet<IR>({ candidates: [base('R-B', 2, { t: 2 }), base('R-A', 1, { t: 1 })], overrides: [] })
    expect(a.manifest.hash).toBe(b.manifest.hash)
    expect(a.manifest.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('a different resolved set yields a different hash', () => {
    const a = resolveRuleSet<IR>({ candidates: [base('R-A', 1, { t: 1 })], overrides: [] })
    const b = resolveRuleSet<IR>({ candidates: [base('R-A', 2, { t: 1 })], overrides: [] })
    expect(a.manifest.hash).not.toBe(b.manifest.hash)
  })

  it('manifest rules are ordered by ruleId (stable)', () => {
    const { manifest } = resolveRuleSet<IR>({
      candidates: [base('R-Z', 1), base('R-A', 1), base('R-M', 1)],
      overrides: [],
    })
    expect(manifest.rules.map((r) => r.ruleId)).toEqual(['R-A', 'R-M', 'R-Z'])
  })
})

describe('canonicalStringify', () => {
  it('sorts object keys recursively', () => {
    expect(canonicalStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
  })
})
