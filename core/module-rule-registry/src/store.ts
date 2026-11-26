import type { ScopedRule, RuleOverride, ResolvedManifest, RuleDraft, DraftTarget, DraftStatus, OwnerScope, TemplateOwnerScope, OwnerRef, TemplateMember } from './types.js'
import type { TemplateCriteria } from './suggest.js'

/** A rule_version row to insert (promote). */
export interface RuleVersionRow {
  ruleId: string
  version: number
  ownerScope: OwnerScope
  ownerId: string
  appliesTo: string
  ir: unknown
  nl?: string | null
  severity: string
  /** Metadata hiển thị/provenance — ĐỤC với registry (§3.5). Xem migration 004. */
  name?: string | null
  category?: string | null
  cite?: unknown | null           // {doc, at, kind} — app định nghĩa hình dạng
  citeReviewed?: boolean
  contentHash: string
  authoredBy: string
  approvedBy?: string | null
}

// Persistence port for the registry (implemented by a pg adapter — M1 wiring).
// Kept separate from resolve() so the merge logic stays a pure, DB-free function.

export interface ResolveInputs<IR = unknown> {
  /** All candidate rules that could apply to the client, each tagged with a
   *  layer + source. M1: base-template members + client-owned rules.
   *  M2 adds segment/topic template members. resolve() does the merge. */
  candidates: ScopedRule<IR>[]
  /** Per-client overrides (disable/patch by rule_id). */
  overrides: RuleOverride[]
}

export interface RegistryStore<IR = unknown> {
  /** Fetch everything resolve() needs for one client at a point in time. */
  /** `firmId` (optional): kéo thêm ĐIỀU CHỈNH tầm hãng — áp cho mọi khách của hãng (§12.2). */
  getResolveInputs(clientId: string, asOf: string, firmId?: string): Promise<ResolveInputs<IR>>
  /** Persist the run lockfile (design §2 tầng 3). */
  writeRunManifest(runId: string, clientId: string, asOf: string, manifest: ResolvedManifest): Promise<void>
  /** All templates a firm owns (for suggest-subscribe, design §8). */
  getFirmTemplates(firmId: string): Promise<TemplateCriteria[]>
  /** Templates của một chủ bất kỳ (platform → base; firm → segment/khung). */
  getTemplatesForOwner(scope: TemplateOwnerScope, ownerId: string): Promise<TemplateCriteria[]>

  // ── Authoring lifecycle (design §5.1) ──
  createDraft(input: { nl: string; target: DraftTarget; author: string }): Promise<string>
  getDraft(id: string): Promise<RuleDraft | null>
  listDrafts(status?: DraftStatus): Promise<RuleDraft[]>
  updateDraft(
    id: string,
    patch: Partial<Pick<RuleDraft, 'ruleId' | 'appliesTo' | 'spec' | 'issues' | 'status' | 'promotedTo'>>,
  ): Promise<void>
  /** Next version for (owner, rule_id) — 1 if none yet. */
  nextRuleVersion(ownerScope: OwnerScope, ownerId: string, ruleId: string): Promise<number>
  /** Insert an active rule_version (promote). */
  insertRuleVersion(row: RuleVersionRow): Promise<void>

  // ── Channels & template versioning (M3, design §2/§7) ──
  /** Current pointer of a (template, channel) — null if never moved. */
  currentChannelPointer(templateId: string, channel: string): Promise<{ version: number; prevVersion: number | null } | null>
  /** Append a channel move (roll-out). */
  moveChannel(input: { templateId: string; channel: string; version: number; movedBy: string; reason?: string; prevVersion?: number | null }): Promise<void>
  /** Publish a draft template_version (status draft → published; records approver). */
  publishTemplateVersion(templateId: string, version: number, approvedBy: string): Promise<void>
  /** Meta of a template_version (for the author≠approver gate) — null if absent. */
  getTemplateVersionMeta(templateId: string, version: number): Promise<{ authoredBy: string; status: string } | null>

  // ── Promote-to-template (loại C) ──
  /** Chủ sở hữu template (cho rule_version owner) — null nếu template không tồn tại.
   *  Thay cho getTemplateFirm(): template có thể thuộc `platform` (base) hoặc `firm` (segment/khung). */
  getTemplateOwner(templateId: string): Promise<{ scope: TemplateOwnerScope; id: string } | null>
  /** Version cao nhất của template + status — null nếu chưa có version nào. */
  latestTemplateVersion(templateId: string): Promise<{ version: number; status: string } | null>
  /** Members của một template_version. */
  getTemplateMembers(templateId: string, version: number): Promise<TemplateMember[]>
  /** Member rules (IR) của một template_version — để back-test chạy engine (design §7.2). */
  getTemplateVersionRules(templateId: string, version: number): Promise<Array<{ ruleId: string; ir: unknown }>>
  /** Tạo một template_version DRAFT rỗng. */
  createDraftTemplateVersion(templateId: string, version: number, authoredBy: string): Promise<void>
  /** Thêm/replace member (cùng rule_id → cập nhật rule_version). */
  /** `ruleOwner` bỏ trống ⇒ chủ của template. Truyền vào để lắp luật của chủ khác (thư viện DQA). */
  addTemplateMember(templateId: string, version: number, ruleId: string, ruleVersion: number, ruleOwner?: OwnerRef): Promise<void>
}
