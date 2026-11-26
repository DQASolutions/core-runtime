import { createHash } from 'node:crypto'
import type { RegistryStore } from './store.js'
import type { ResolveResult, RuleConflict } from './types.js'
import { resolveRuleSet, canonicalStringify } from './resolve.js'
import { detectConflicts } from './conflicts.js'
import { suggestTemplates, type TemplateCriteria, type ClientAttrs } from './suggest.js'

const PROMOTABLE = new Set(['validated', 'back-tested', 'pending-review'])
const hashIR = (ir: unknown): string => createHash('sha256').update(canonicalStringify(ir)).digest('hex')

// Orchestrators tying the store to the pure resolve(). This is the surface the
// check engine calls (via loadRuleStore wiring): give it a client + asOf, get the
// merged rule-set. The registry never touches facts (design §9, "MÙ FACT").

/** Promote a VALIDATED client-scoped draft (loại A — standalone) into an active
 *  rule_version (owner=client). Governance = quyền `rules.manage` (app-layer); tự-duyệt ĐƯỢC PHÉP
 *  — cổng identity author≠approver đã gỡ khỏi kernel.
 *  Chạy trong 1 transaction nếu caller truyền txn client làm Queryable (2 write). */

/**
 * A rule about to go LIVE must be able to STATE what it found.
 *
 * `finding` is optional in the IR schema on purpose — a rule under test, or one being authored, may not have
 * one yet. But the moment it becomes an active rule it will fire on real books, and without `finding` the
 * evaluator can emit neither a message nor an amount: it reports "something is wrong here" with no what and
 * no how much.
 *
 * Measured on a real registry before this gate existed: **48 of 167 active rules had no `finding`**, among
 * them the core integrity rules (ledger-vs-subledger, rollforward, cash-never-negative). One fired
 * `critical` on an account whose subledger was off by 1.9 billion and surfaced with `exposure: 0` — a
 * reviewer could not tell it from a rounding error. They came from the AI extraction path, which emits only
 * `expr`, and nothing downstream objected.
 *
 * Same family as two earlier losses on this pipeline (`name`, `cite`). The gate belongs HERE — at the
 * boundary where a rule starts running — not in the schema, which also guards rules that only ever exist
 * inside tests.
 */
function assertStatable(spec: unknown, ruleId: string): void {
  const f = (spec as { finding?: { message?: unknown } } | null)?.finding
  if (!f || typeof f.message !== 'string' || !f.message.trim()) {
    throw new Error(
      `luật '${ruleId}' thiếu finding.message — luật chạy được mà không nói được nó phát hiện gì thì không được promote`,
    )
  }
}

export async function promoteDraftToClientRule<IR = unknown>(
  store: RegistryStore<IR>,
  draftId: string,
  approvedBy: string,
): Promise<{ ruleId: string; version: number }> {
  const d = await store.getDraft(draftId)
  if (!d) throw new Error(`draft ${draftId} không tồn tại`)
  if (d.target.kind !== 'client') throw new Error(`promoteDraftToClientRule chỉ cho target 'client' (draft='${d.target.kind}')`)
  if (!PROMOTABLE.has(d.status)) throw new Error(`draft status '${d.status}' chưa sẵn sàng promote`)
  if (!d.spec) throw new Error('draft chưa có spec (chưa parse)')
  if (!d.ruleId || !d.appliesTo) throw new Error('draft thiếu ruleId/appliesTo')
  assertStatable(d.spec, d.ruleId)
  // Tự-duyệt ĐƯỢC PHÉP: cổng duyệt là quyền rules.manage (enforce ở app-layer). Người có quyền duyệt
  // tự duyệt luật mình soạn được — không ràng buộc identity author≠approver.

  const clientId = d.target.id
  const version = await store.nextRuleVersion('client', clientId, d.ruleId)
  await store.insertRuleVersion({
    ruleId: d.ruleId, version, ownerScope: 'client', ownerId: clientId,
    appliesTo: d.appliesTo, ir: d.spec, nl: d.nl,
    severity: (d.spec as any)?.severity ?? 'info',
    contentHash: hashIR(d.spec), authoredBy: d.author, approvedBy,
    // Chuyển căn cứ pháp lý draft → luật chạy (nếu bỏ, màn Thư viện quy định thấy "không nguồn").
    cite: d.target.cite ?? null, citeReviewed: d.target.citeReviewed ?? false,
  })
  await store.updateDraft(draftId, { status: 'active', promotedTo: `${d.ruleId}@${version}` })
  return { ruleId: d.ruleId, version }
}

/** Promote a VALIDATED template-scoped draft (loại C) into a rule_version owned by the
 *  TEMPLATE's owner (platform for base, firm for segment/khung) + add
 *  it to a DRAFT template_version (bump from latest, or reuse the open draft). The
 *  new template version is NOT published — publish + roll-out are separate (M3, §2).
 *  Governance = quyền `rules.manage` (app-layer); tự-duyệt ĐƯỢC PHÉP. */
export async function promoteDraftToTemplateRule<IR = unknown>(
  store: RegistryStore<IR>,
  draftId: string,
  approvedBy: string,
): Promise<{ ruleId: string; ruleVersion: number; templateVersion: number }> {
  const d = await store.getDraft(draftId)
  if (!d) throw new Error(`draft ${draftId} không tồn tại`)
  if (d.target.kind !== 'template') throw new Error(`promoteDraftToTemplateRule chỉ cho target 'template' (draft='${d.target.kind}')`)
  if (!PROMOTABLE.has(d.status)) throw new Error(`draft status '${d.status}' chưa sẵn sàng promote`)
  if (!d.spec) throw new Error('draft chưa có spec (chưa parse)')
  if (!d.ruleId || !d.appliesTo) throw new Error('draft thiếu ruleId/appliesTo')
  assertStatable(d.spec, d.ruleId)
  // Tự-duyệt ĐƯỢC PHÉP: cổng duyệt là quyền rules.manage (enforce ở app-layer). Người có quyền duyệt
  // tự duyệt luật mình soạn được — không ràng buộc identity author≠approver.

  const templateId = d.target.id
  const owner = await store.getTemplateOwner(templateId)
  if (!owner) throw new Error(`template ${templateId} không tồn tại`)

  // Luật member LUÔN thuộc chủ của template: platform cho base, firm cho segment/khung.
  // (getResolveInputs join theo cùng cặp (owner_scope, owner_id) — hai chỗ phải khớp.)
  const ruleVersion = await store.nextRuleVersion(owner.scope, owner.id, d.ruleId)
  await store.insertRuleVersion({
    ruleId: d.ruleId, version: ruleVersion, ownerScope: owner.scope, ownerId: owner.id,
    appliesTo: d.appliesTo, ir: d.spec, nl: d.nl,
    severity: (d.spec as any)?.severity ?? 'info',
    contentHash: hashIR(d.spec), authoredBy: d.author, approvedBy,
    // Chuyển căn cứ pháp lý draft → luật chạy (nếu bỏ, màn Thư viện quy định thấy "không nguồn").
    cite: d.target.cite ?? null, citeReviewed: d.target.citeReviewed ?? false,
  })

  // Đích = một template_version DRAFT: dùng lại draft đang mở, else bump từ latest.
  const latest = await store.latestTemplateVersion(templateId)
  let tv: number
  if (latest && latest.status === 'draft') {
    tv = latest.version
  } else {
    tv = (latest?.version ?? 0) + 1
    await store.createDraftTemplateVersion(templateId, tv, d.author)
    // Chép member sang version nháp PHẢI mang theo chủ của luật. Bỏ `m.ruleOwner` thì
    // addTemplateMember mặc định về chủ của TEMPLATE — một luật platform nằm trong bộ của hãng
    // sẽ lặng lẽ trở thành luật của hãng, và resolve sau đó không tìm thấy nó nữa.
    for (const m of latest ? await store.getTemplateMembers(templateId, latest.version) : [])
      await store.addTemplateMember(templateId, tv, m.ruleId, m.ruleVersion, m.ruleOwner)
  }
  await store.addTemplateMember(templateId, tv, d.ruleId, ruleVersion)
  await store.updateDraft(draftId, { status: 'active', promotedTo: `${d.ruleId}@${ruleVersion}→tpl@${tv}` })
  return { ruleId: d.ruleId, ruleVersion, templateVersion: tv }
}

/** Resolve the effective rule-set for a client at a point in time. No side effects. */
export async function resolveForClient<IR = unknown>(
  store: RegistryStore<IR>,
  clientId: string,
  asOf: string,
  firmId?: string,
): Promise<ResolveResult<IR>> {
  const inputs = await store.getResolveInputs(clientId, asOf, firmId)
  return resolveRuleSet<IR>(inputs)
}

/** Suggest which of a firm's templates a client qualifies for (design §8) — for the
 *  gợi-ý-rồi-xác-nhận onboard flow (hãng duyệt, không auto-apply). */
export async function suggestTemplatesForClient<IR = unknown>(
  store: RegistryStore<IR>,
  firmId: string,
  attrs: ClientAttrs,
): Promise<TemplateCriteria[]> {
  const templates = await store.getFirmTemplates(firmId)
  return suggestTemplates(templates, attrs)
}

// ── Channels & rollout (M3, design §7) ─────────────────────────────────────────

/** Publish a DRAFT template_version → immutable published (does NOT roll out — §2).
 *  Governance = quyền `rules.manage` (app-layer); tự-duyệt ĐƯỢC PHÉP. */
export async function publishTemplateVersion<IR = unknown>(
  store: RegistryStore<IR>, templateId: string, version: number, approvedBy: string,
): Promise<void> {
  const meta = await store.getTemplateVersionMeta(templateId, version)
  if (!meta) throw new Error(`template version ${templateId}@${version} không tồn tại`)
  if (meta.status !== 'draft') throw new Error(`chỉ publish version status='draft' (đang '${meta.status}')`)
  // Tự-duyệt ĐƯỢC PHÉP (xem promote): cổng là quyền rules.manage ở app-layer.
  await store.publishTemplateVersion(templateId, version, approvedBy)
}

/** Roll-out: dịch con trỏ channel sang một version (append-only, giữ prev). */
export async function moveChannel<IR = unknown>(
  store: RegistryStore<IR>, i: { templateId: string; channel: string; version: number; movedBy: string; reason?: string },
): Promise<void> {
  const cur = await store.currentChannelPointer(i.templateId, i.channel)
  await store.moveChannel({ ...i, prevVersion: cur?.version ?? null })
}

/** Rollback tức thì: dịch channel về prev_version của con trỏ hiện tại (§7.4). */
export async function rollbackChannel<IR = unknown>(
  store: RegistryStore<IR>, i: { templateId: string; channel: string; movedBy: string; reason?: string },
): Promise<number> {
  const cur = await store.currentChannelPointer(i.templateId, i.channel)
  if (!cur) throw new Error(`channel '${i.channel}' chưa có pointer để rollback`)
  if (cur.prevVersion == null) throw new Error(`channel '${i.channel}' đang ở version đầu, không có prev`)
  await store.moveChannel({ templateId: i.templateId, channel: i.channel, version: cur.prevVersion, movedBy: i.movedBy, reason: i.reason ?? 'rollback', prevVersion: cur.version })
  return cur.prevVersion
}

/** Config-time gate (design §6): what same-rank collisions would a client hit? Run
 *  this at subscribe/publish time and surface conflicts for a human to resolve — do
 *  NOT let them resolve silently at check time. */
export async function detectConflictsForClient<IR = unknown>(
  store: RegistryStore<IR>,
  clientId: string,
  asOf: string,
): Promise<RuleConflict[]> {
  const { candidates } = await store.getResolveInputs(clientId, asOf)
  return detectConflicts(candidates)
}

/** Resolve AND persist the immutable lockfile for a run (design §2 tầng 3). */
export async function resolveAndLock<IR = unknown>(
  store: RegistryStore<IR>,
  runId: string,
  clientId: string,
  asOf: string,
  firmId?: string,
): Promise<ResolveResult<IR>> {
  const result = await resolveForClient(store, clientId, asOf, firmId)
  await store.writeRunManifest(runId, clientId, asOf, result.manifest)
  return result
}
