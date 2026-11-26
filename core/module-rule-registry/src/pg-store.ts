import type { Queryable } from './db.js'
import type { RegistryStore, ResolveInputs, RuleVersionRow } from './store.js'
import type { ScopedRule, RuleOverride, RuleSource, ResolvedManifest, RuleDraft, DraftTarget, DraftStatus, OwnerScope, TemplateOwnerScope, OwnerRef, TemplateMember } from './types.js'
import { LAYER } from './types.js'
import type { TemplateCriteria } from './suggest.js'

const DRAFT_COLS = 'id, nl, target, status, rule_id, applies_to, spec, issues, promoted_to, author, submitted_at'
function rowToDraft(r: any): RuleDraft {
  return {
    id: r.id, nl: r.nl, target: r.target as DraftTarget, status: r.status as DraftStatus,
    ruleId: r.rule_id, appliesTo: r.applies_to, spec: r.spec, issues: r.issues,
    promotedTo: r.promoted_to, author: r.author, submittedAt: r.submitted_at,
  }
}

// Postgres adapter for RegistryStore over the `rule_registry` schema (migration 001).
// Fetches candidate rules via the client's SUBSCRIPTIONS (so base + future segment
// templates flow uniformly) + client-owned rules + overrides. Pure mapping; the merge
// itself is resolveRuleSet() (design §4). Depends only on `Queryable`.

function sourceForRank(rank: number, templateId: string, templateVersion: number): RuleSource {
  const kind = rank <= LAYER.base ? 'base-template' : rank < LAYER.topic ? 'segment-template' : 'topic-template'
  return { kind, ownerId: templateId, templateVersion }
}

export class PgRegistryStore implements RegistryStore {
  constructor(
    private readonly db: Queryable,
    private readonly schema = 'rule_registry',
  ) {}

  private q(sql: string): string {
    // schema is a fixed internal constant, never user input → safe to inline.
    return sql.replace(/\{s\}/g, this.schema)
  }

  async getResolveInputs(clientId: string, asOf: string, firmId?: string): Promise<ResolveInputs> {
    const candidates: ScopedRule[] = []

    // 1) Subscribed templates → resolve version (pinned ?? latest published) → members.
    const subs = await this.db.query(
      this.q(`SELECT s.template_id, s.pinned_version, s.channel, t.layer_rank,
                     t.owner_scope, t.owner_id
              FROM {s}.client_subscription s
              JOIN {s}.rule_template t ON t.id = s.template_id
              WHERE s.client_id = $1 AND s.status = 'active'`),
      [clientId],
    )
    for (const sub of subs.rows) {
      // version = pinned ?? channel pointer ?? max(published) fallback (§7).
      let version: number | null = sub.pinned_version
      if (version == null) version = (await this.currentChannelPointer(sub.template_id, sub.channel))?.version ?? null
      if (version == null) {
        const latest = await this.db.query(
          this.q(`SELECT max(version) AS v FROM {s}.rule_template_version
                  WHERE template_id = $1 AND status = 'published'`),
          [sub.template_id],
        )
        version = latest.rows[0]?.v ?? null
      }
      if (version == null) continue // template có subscription nhưng chưa published version nào
      // Chủ của luật do MEMBER khai, không suy từ chủ của template (migration 007). Nhờ vậy bộ
      // luật của một hãng chứa được luật của platform. Vẫn join theo (owner_scope, owner_id) để
      // không dính rule cùng rule_id của owner khác (client shadow, hoặc firm khác cùng rule_id).
      //
      // HIỆU LỰC THEO NGÀY áp cho MỌI luật, không riêng luật của khách (N5). Một check trích từ
      // Thông tư đã bị thay thế phải TỰ NGỪNG cho kỳ sau ngày hết hiệu lực — không chờ ai nhớ ra
      // mà gỡ nó khỏi template. Nguồn của cặp ngày này là VÒNG ĐỜI CỦA VĂN BẢN (app chiếu xuống
      // `rule_version.effective_*`); registry chỉ biết có hai cột ngày, không biết "văn bản" là gì.
      //
      // Không phá bất biến tái lập: `asOf` là ĐẦU VÀO của resolve, nên cùng (asOf, base@asOf) vẫn
      // cho cùng một bộ luật. Nó phá tính bất biến của một template_version đã publish — đúng như
      // mong muốn: version không đổi, nhưng luật trong đó có thể đã hết hiệu lực pháp lý.
      const members = await this.db.query(
        this.q(`SELECT rv.rule_id, rv.version, rv.ir
                FROM {s}.rule_template_member m
                JOIN {s}.rule_version rv
                  ON rv.owner_scope = m.rule_owner_scope AND rv.owner_id = m.rule_owner_id
                 AND rv.rule_id = m.rule_id AND rv.version = m.rule_version
                WHERE m.template_id = $1 AND m.template_version = $2
                  AND (rv.effective_from IS NULL OR rv.effective_from <= $3)
                  AND (rv.effective_to   IS NULL OR rv.effective_to   >= $3)`),
        [sub.template_id, version, asOf],
      )
      for (const r of members.rows) {
        candidates.push({
          ruleId: r.rule_id,
          version: r.version,
          ir: r.ir,
          layer: sub.layer_rank,
          source: sourceForRank(sub.layer_rank, sub.template_id, version),
        })
      }
    }

    // 2) Client-owned active rules (effective-dated) — layer above templates.
    const own = await this.db.query(
      this.q(`SELECT rule_id, version, ir FROM {s}.rule_version
              WHERE owner_scope = 'client' AND owner_id = $1 AND status = 'active'
                AND (effective_from IS NULL OR effective_from <= $2)
                AND (effective_to   IS NULL OR effective_to   >= $2)`),
      [clientId, asOf],
    )
    for (const r of own.rows) {
      candidates.push({
        ruleId: r.rule_id,
        version: r.version,
        ir: r.ir,
        layer: LAYER.client,
        source: { kind: 'client', ownerId: clientId },
      })
    }

    // 3) ĐIỀU CHỈNH: tầm firm (mọi khách của hãng) + tầm client. Client đè firm — thứ tự áp
    //    do resolveRuleSet quyết theo OVERRIDE_RANK, không phụ thuộc thứ tự hàng trả về.
    //    `firmId` optional: caller không truyền ⇒ chỉ lấy override cấp khách (tương thích cũ).
    const ov = await this.db.query(
      this.q(`SELECT rule_id, scope, params, patch, reason FROM {s}.rule_override
               WHERE (scope = 'client' AND owner_id = $1)
                  OR ($2::uuid IS NOT NULL AND scope = 'firm' AND owner_id = $2)`),
      [clientId, firmId ?? null],
    )
    const overrides: RuleOverride[] = ov.rows.map((r) => ({
      ruleId: r.rule_id,
      scope: r.scope,
      ...(r.params != null ? { params: r.params } : {}),
      ...(r.patch != null ? { patch: r.patch } : {}),
      reason: r.reason ?? '',
    }))

    return { candidates, overrides }
  }

  async writeRunManifest(runId: string, clientId: string, asOf: string, manifest: ResolvedManifest): Promise<void> {
    await this.db.query(
      this.q(`INSERT INTO {s}.run_manifest (run_id, client_id, as_of, rules, overrides, manifest_hash)
              VALUES ($1, $2, $3, $4, $5, $6)`),
      [runId, clientId, asOf, JSON.stringify(manifest.rules), JSON.stringify(manifest.overridesApplied), manifest.hash],
    )
  }

  async getFirmTemplates(firmId: string): Promise<TemplateCriteria[]> {
    return this.getTemplatesForOwner('firm', firmId)
  }

  async getTemplatesForOwner(scope: TemplateOwnerScope, ownerId: string): Promise<TemplateCriteria[]> {
    const { rows } = await this.db.query(
      this.q(`SELECT id, key, applies_when, layer_rank FROM {s}.rule_template
              WHERE owner_scope = $1 AND owner_id = $2`),
      [scope, ownerId],
    )
    return rows.map((r) => ({ templateId: r.id, key: r.key, appliesWhen: r.applies_when ?? null, layerRank: r.layer_rank }))
  }

  // ── Authoring lifecycle ──
  async createDraft(input: { nl: string; target: DraftTarget; author: string }): Promise<string> {
    const { rows } = await this.db.query(
      this.q(`INSERT INTO {s}.rule_draft (nl, target, author) VALUES ($1, $2, $3) RETURNING id`),
      [input.nl, JSON.stringify(input.target), input.author],
    )
    return rows[0].id
  }

  async getDraft(id: string): Promise<RuleDraft | null> {
    const { rows } = await this.db.query(this.q(`SELECT ${DRAFT_COLS} FROM {s}.rule_draft WHERE id = $1`), [id])
    return rows[0] ? rowToDraft(rows[0]) : null
  }

  async listDrafts(status?: DraftStatus): Promise<RuleDraft[]> {
    const { rows } = status
      ? await this.db.query(this.q(`SELECT ${DRAFT_COLS} FROM {s}.rule_draft WHERE status = $1 ORDER BY submitted_at`), [status])
      : await this.db.query(this.q(`SELECT ${DRAFT_COLS} FROM {s}.rule_draft ORDER BY submitted_at`))
    return rows.map(rowToDraft)
  }

  async updateDraft(
    id: string,
    patch: Partial<Pick<RuleDraft, 'ruleId' | 'appliesTo' | 'spec' | 'issues' | 'status' | 'promotedTo'>>,
  ): Promise<void> {
    const map: Record<string, string> = { ruleId: 'rule_id', appliesTo: 'applies_to', spec: 'spec', issues: 'issues', status: 'status', promotedTo: 'promoted_to' }
    const json = new Set(['spec', 'issues'])
    const sets: string[] = [], vals: unknown[] = []
    for (const [k, col] of Object.entries(map)) {
      if (!(k in patch)) continue
      const v = (patch as any)[k]
      vals.push(json.has(k) && v != null ? JSON.stringify(v) : v)
      sets.push(`${col} = $${vals.length}`)
    }
    if (!sets.length) return
    vals.push(id)
    await this.db.query(this.q(`UPDATE {s}.rule_draft SET ${sets.join(', ')} WHERE id = $${vals.length}`), vals)
  }

  async nextRuleVersion(ownerScope: OwnerScope, ownerId: string, ruleId: string): Promise<number> {
    const { rows } = await this.db.query(
      this.q(`SELECT coalesce(max(version), 0) + 1 AS v FROM {s}.rule_version
              WHERE owner_scope = $1 AND owner_id = $2 AND rule_id = $3`),
      [ownerScope, ownerId, ruleId],
    )
    return rows[0].v
  }

  // ── Channels & template versioning ──
  async currentChannelPointer(templateId: string, channel: string): Promise<{ version: number; prevVersion: number | null } | null> {
    const { rows } = await this.db.query(
      this.q(`SELECT version, prev_version FROM {s}.channel_pointer_history
              WHERE template_id = $1 AND channel = $2 ORDER BY id DESC LIMIT 1`),
      [templateId, channel],
    )
    return rows[0] ? { version: rows[0].version, prevVersion: rows[0].prev_version } : null
  }

  async moveChannel(i: { templateId: string; channel: string; version: number; movedBy: string; reason?: string; prevVersion?: number | null }): Promise<void> {
    await this.db.query(
      this.q(`INSERT INTO {s}.channel_pointer_history (template_id, channel, version, moved_by, reason, prev_version)
              VALUES ($1, $2, $3, $4, $5, $6)`),
      [i.templateId, i.channel, i.version, i.movedBy, i.reason ?? null, i.prevVersion ?? null],
    )
  }

  async publishTemplateVersion(templateId: string, version: number, approvedBy: string): Promise<void> {
    await this.db.query(
      this.q(`UPDATE {s}.rule_template_version SET status = 'published', approved_by = $3, approved_at = now()
              WHERE template_id = $1 AND version = $2 AND status = 'draft'`),
      [templateId, version, approvedBy],
    )
  }

  async getTemplateVersionMeta(templateId: string, version: number): Promise<{ authoredBy: string; status: string } | null> {
    const { rows } = await this.db.query(
      this.q(`SELECT authored_by, status FROM {s}.rule_template_version WHERE template_id = $1 AND version = $2`),
      [templateId, version],
    )
    return rows[0] ? { authoredBy: rows[0].authored_by, status: rows[0].status } : null
  }

  // ── Promote-to-template ──
  async getTemplateOwner(templateId: string): Promise<{ scope: TemplateOwnerScope; id: string } | null> {
    const { rows } = await this.db.query(
      this.q(`SELECT owner_scope, owner_id FROM {s}.rule_template WHERE id = $1`), [templateId])
    return rows[0] ? { scope: rows[0].owner_scope, id: rows[0].owner_id } : null
  }

  async latestTemplateVersion(templateId: string): Promise<{ version: number; status: string } | null> {
    const { rows } = await this.db.query(
      this.q(`SELECT version, status FROM {s}.rule_template_version WHERE template_id = $1 ORDER BY version DESC LIMIT 1`),
      [templateId],
    )
    return rows[0] ? { version: rows[0].version, status: rows[0].status } : null
  }

  async getTemplateMembers(templateId: string, version: number): Promise<TemplateMember[]> {
    const { rows } = await this.db.query(
      this.q(`SELECT rule_id, rule_version, rule_owner_scope, rule_owner_id
              FROM {s}.rule_template_member WHERE template_id = $1 AND template_version = $2`),
      [templateId, version],
    )
    return rows.map((r) => ({
      ruleId: r.rule_id, ruleVersion: r.rule_version,
      ruleOwner: { scope: r.rule_owner_scope, id: r.rule_owner_id },
    }))
  }

  async getTemplateVersionRules(templateId: string, version: number): Promise<Array<{ ruleId: string; ir: unknown }>> {
    const { rows } = await this.db.query(
      this.q(`SELECT rv.rule_id, rv.ir
              FROM {s}.rule_template_member m
              JOIN {s}.rule_version rv ON rv.owner_scope = m.rule_owner_scope AND rv.owner_id = m.rule_owner_id
                AND rv.rule_id = m.rule_id AND rv.version = m.rule_version
              WHERE m.template_id = $1 AND m.template_version = $2`),
      [templateId, version],
    )
    return rows.map((r) => ({ ruleId: r.rule_id, ir: r.ir }))
  }

  async createDraftTemplateVersion(templateId: string, version: number, authoredBy: string): Promise<void> {
    await this.db.query(
      this.q(`INSERT INTO {s}.rule_template_version (template_id, version, change_kind, content_hash, status, authored_by)
              VALUES ($1, $2, 'additive', '', 'draft', $3)`),
      [templateId, version, authoredBy],
    )
  }

  /**
   * `ruleOwner` bỏ trống ⇒ chủ của template (ngữ nghĩa trước migration 007). Truyền vào để
   * lắp luật của chủ KHÁC — vd hãng lắp luật từ Thư viện quy định của platform.
   */
  async addTemplateMember(
    templateId: string, version: number, ruleId: string, ruleVersion: number, ruleOwner?: OwnerRef,
  ): Promise<void> {
    const owner = ruleOwner ?? (await this.getTemplateOwner(templateId))
    if (!owner) throw new Error(`template ${templateId} không tồn tại`)
    await this.db.query(
      this.q(`INSERT INTO {s}.rule_template_member
                (template_id, template_version, rule_id, rule_version, rule_owner_scope, rule_owner_id)
              VALUES ($1, $2, $3, $4, $5, $6)
              ON CONFLICT (template_id, template_version, rule_id) DO UPDATE
                SET rule_version = EXCLUDED.rule_version,
                    rule_owner_scope = EXCLUDED.rule_owner_scope,
                    rule_owner_id = EXCLUDED.rule_owner_id`),
      [templateId, version, ruleId, ruleVersion, owner.scope, owner.id],
    )
  }

  async insertRuleVersion(r: RuleVersionRow): Promise<void> {
    await this.db.query(
      this.q(`INSERT INTO {s}.rule_version
              (rule_id, version, owner_scope, owner_id, applies_to, ir, nl, severity, status, content_hash,
               authored_by, approved_by, approved_at, name, category, cite, cite_reviewed)
              VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,$11::uuid,
                      CASE WHEN $11::uuid IS NULL THEN NULL ELSE now() END, $12, $13, $14, $15)`),
      [r.ruleId, r.version, r.ownerScope, r.ownerId, r.appliesTo, JSON.stringify(r.ir), r.nl ?? null, r.severity,
       r.contentHash, r.authoredBy, r.approvedBy ?? null,
       r.name ?? null, r.category ?? null, r.cite != null ? JSON.stringify(r.cite) : null, r.citeReviewed ?? false],
    )
  }
}
