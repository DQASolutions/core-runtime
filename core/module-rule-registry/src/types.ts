// Core types for the rule-registry. Domain-agnostic: a rule's condition is carried
// as opaque `IR` (the registry never interprets it — see design §9, "MÙ FACT").

/** Where a rule/draft is owned. `firm` rules reach clients only via a template.
 *  `platform` owns the BASE ruleset: firms inherit it, they do not own a copy of it
 *  (inherit-model). */
export type OwnerScope = 'platform' | 'firm' | 'client'

/** Who can own a TEMPLATE. Clients never own templates — they subscribe to them. */
export type TemplateOwnerScope = 'platform' | 'firm'

/** Chủ của một luật hoặc một template. */
export interface OwnerRef {
  scope: TemplateOwnerScope
  id: string
}

/**
 * Một luật nằm trong một template_version.
 *
 * `ruleOwner` TÁCH KHỎI chủ của template (migration 007): ai SỞ HỮU luật ≠ ai LẮP bộ luật.
 * Nhờ đó bộ luật của một hãng chứa được luật của platform (thư viện dùng chung) bên cạnh luật
 * do chính hãng soạn.
 */
export interface TemplateMember {
  ruleId: string
  ruleVersion: number
  ruleOwner: OwnerRef
}

/** The single, well-known owner id of the platform tier. Distinct from the SYS actor
 *  (all-zero uuid) so an audit trail can tell "owned by platform" from "acted by system". */
export const PLATFORM_ID = '00000000-0000-0000-0000-000000000001'

/** Tầm của một ĐIỀU CHỈNH. Client đè firm. (Miễn trừ là động từ KHÁC — ở app, §12.2.) */
export type OverrideScope = 'firm' | 'client'
export const OVERRIDE_RANK: Record<OverrideScope, number> = { firm: 0, client: 10 }

/** Precedence layers (higher wins). Kept as an enum-like const so M2 templates
 *  slot between base and client without touching resolve(). Design §4 stack:
 *  base < segment < topic < client < override. */
export const LAYER = {
  base: 0,
  segment: 10,
  topic: 20,
  client: 100,
} as const
export type LayerRank = number

/** Provenance of a resolved rule — how it reached this client. */
export interface RuleSource {
  /** 'base-template' | 'segment-template' | 'topic-template' | 'client' */
  kind: 'base-template' | 'segment-template' | 'topic-template' | 'client'
  /** template id (for template layers) or client id (for client layer). */
  ownerId?: string
  templateVersion?: number
}

/** A candidate rule feeding resolve(): one rule_version pinned at a layer.
 *  `ir` is opaque to the registry (generic). */
export interface ScopedRule<IR = unknown> {
  ruleId: string
  version: number
  ir: IR
  layer: LayerRank
  source: RuleSource
}

/** Per-client exception on a single rule (by rule_id — survives template bumps). */
/** ĐIỀU CHỈNH (tuning) — luật VẪN CHẠY. "Không áp luật" là động từ khác (waiver, ở app §12.2).
 *  KHÔNG có `enabled`: nó là miễn-trừ nguỵ trang thành cấu hình, và nó trượt bất biến TÁI LẬP (N6). */
export interface RuleOverride {
  ruleId: string
  scope: OverrideScope
  /** Vặn NGƯỠNG qua param key. IR không bị chạm ⇒ content_hash giữ nguyên (§A.3).
   *  `patch` shallow-merge KHÔNG chạm nổi một `lit` nằm sâu trong cây `expr` — nên ngưỡng phải là `param`. */
  params?: Record<string, number>
  /** Chỉ dùng cho khoá cấp một của RuleIR (thực tế: `severity`). */
  patch?: Record<string, unknown>
  reason: string
}

/** A resolved rule after layering + overrides — what actually runs. */
export interface ResolvedRule<IR = unknown> {
  ruleId: string
  version: number
  ir: IR
  source: RuleSource
}

/** Immutable per-run lockfile: exactly which rule_versions fired (design §2 tầng 3). */
export interface ResolvedManifest {
  rules: Array<{ ruleId: string; version: number; source: RuleSource }>
  overridesApplied: Array<{ ruleId: string; kind: 'params' | 'patched'; scope: OverrideScope }>
  /** sha256 over the canonical resolved rule content → tamper-evident, reproducible. */
  hash: string
}

export interface ResolveResult<IR = unknown> {
  rules: ResolvedRule<IR>[]
  manifest: ResolvedManifest
  /** Ngưỡng bị vặn bởi override (firm → client). Đè lên law_parameter@asOf khi dựng ParamResolver. */
  params: Record<string, number>
}

// ── Authoring lifecycle (design §5.1, §9.5.4) — draft owned by the registry ──────
export type DraftTargetKind = 'client' | 'template' | 'base'
/** Đích của draft — quyết định back-test/conflict/promote. */
export interface DraftTarget {
  kind: DraftTargetKind
  id: string // client_id | template_id | firm_id (base)
  // Căn cứ pháp lý ({doc, at, kind} — app định hình) gắn với draft. PHẢI được chuyển sang
  // rule_version.cite lúc promote, nếu không luật chạy sẽ mất nguồn (màn Thư viện quy định
  // đọc rule_version.cite). Trước đây promote bỏ sót → 82 luật active hiện "không nguồn".
  cite?: unknown | null
  citeReviewed?: boolean
}
export type DraftStatus =
  | 'waiting' | 'needs-input' | 'validated' | 'back-tested' | 'pending-review' | 'active' | 'rejected'

/** Một luật đang soạn (NL → parse → validate → approve → promote). */
export interface RuleDraft {
  id: string
  nl: string
  target: DraftTarget
  status: DraftStatus
  ruleId?: string | null
  appliesTo?: string | null
  spec?: unknown // RuleIR đã parse
  issues?: unknown // UnresolvedSlot[] / lỗi schema
  promotedTo?: string | null // 'rule_id@version' khi active
  author: string
  submittedAt?: string
}

/** A same-rank collision: one rule_id provided at the SAME layer by ≥2 sources with
 *  DIFFERENT versions. resolve() still picks deterministically, but this MUST be
 *  surfaced to a human at CONFIG time (design §6 — giải va chạm lúc cấu hình, không
 *  lúc chạy; không im lặng last-win). Cross-layer same-id is precedence, not conflict. */
export interface RuleConflict {
  ruleId: string
  layer: LayerRank
  contenders: Array<{ version: number; source: RuleSource }>
}
