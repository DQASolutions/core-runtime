-- @dqa-ai-solutions/module-rule-registry · migration 001 — core rule-governance tables (control-plane RDB).
-- Anchored to docs/rule-registry-design.md §3. M1 subset + base-template tables.
--
-- Ranh giới: KHÔNG FK tới service_firm/client_company (registry app). Tham chiếu firm/client
-- bằng uuid, validate qua port TenantRegistry (§9.5.1) — module không cần bảng app cùng DB.
--
-- Mọi tên schema-qualified `rule_registry.` — KHÔNG dùng `SET search_path` (rò rỉ sang
-- pooled connection, phá các query khác). Chạy được trong runner migrate dùng chung.

CREATE SCHEMA IF NOT EXISTS rule_registry;

-- ── Luật nguyên tử, versioned. NL + IR cùng record. Append-only theo (owner, rule_id, version). ──
CREATE TABLE IF NOT EXISTS rule_registry.rule_version (
  rule_id        text        NOT NULL,
  version        int         NOT NULL,
  owner_scope    text        NOT NULL CHECK (owner_scope IN ('firm','client')),
  owner_id       uuid        NOT NULL,               -- firm_id | client_id (không FK — qua port)
  applies_to     text        NOT NULL,               -- entity type (khớp DomainRegistry)
  ir             jsonb       NOT NULL,               -- RuleIR (cây ExprNode) — cái CHẠY
  nl             text,                               -- "viết như nói" gốc
  cite           text,
  severity       text        NOT NULL,
  status         text        NOT NULL CHECK (status IN ('draft','pending-review','active','deprecated')),
  effective_from date,
  effective_to   date,
  content_hash   text        NOT NULL,               -- hash(ir) — tamper-evident
  authored_by    uuid        NOT NULL,
  approved_by    uuid,
  approved_at    timestamptz,
  -- Khoá theo OWNER: cùng rule_id tồn tại ở nhiều owner (base firm + client shadow);
  -- resolve() dedup theo rule_id LOGIC, owner phân biệt dòng VẬT LÝ.
  PRIMARY KEY (owner_scope, owner_id, rule_id, version)
);
CREATE INDEX IF NOT EXISTS idx_rule_version_owner  ON rule_registry.rule_version (owner_scope, owner_id, status);
CREATE INDEX IF NOT EXISTS idx_rule_version_ruleid ON rule_registry.rule_version (rule_id, version);

-- ── Draft = trạng thái TIỀN-version (registry SỞ HỮU, §9.5.4 (i)). App chỉ điền `spec`. ──
CREATE TABLE IF NOT EXISTS rule_registry.rule_draft (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  nl           text        NOT NULL,                 -- người dùng gõ (tiếng Việt)
  target       jsonb       NOT NULL,                 -- {kind:'base'|'template'|'client', id}
  status       text        NOT NULL DEFAULT 'waiting'
               CHECK (status IN ('waiting','needs-input','validated','back-tested','pending-review','active','rejected')),
  rule_id      text,                                 -- id đề xuất (parse điền)
  applies_to   text,                                 -- focus entity type (parse điền)
  spec         jsonb,                                -- RuleIR đã parse
  issues       jsonb,                                -- UnresolvedSlot[] / lỗi schema → UI bù slot
  promoted_to  text,                                 -- 'rule_id@version' khi status=active
  author       uuid        NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rule_draft_status ON rule_registry.rule_draft (status);

-- ── Template = mẫu luật tái dùng (bộ chung hãng = base template, §12.3). ──
CREATE TABLE IF NOT EXISTS rule_registry.rule_template (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  firm_id      uuid        NOT NULL,                 -- không FK — qua port
  key          text        NOT NULL,                 -- 'base' | 'manufacturing' | ...
  name         text        NOT NULL,
  applies_when jsonb,                                -- {business_type:[...], profile:[...]} — GỢI Ý
  layer_rank   int         NOT NULL DEFAULT 0,       -- 0=base < segment < topic
  UNIQUE (firm_id, key)
);

-- ── Version template = BẤT BIẾN. Bump = thêm dòng. ──
CREATE TABLE IF NOT EXISTS rule_registry.rule_template_version (
  template_id    uuid        NOT NULL REFERENCES rule_registry.rule_template(id) ON DELETE CASCADE,
  version        int         NOT NULL,
  change_kind    text        NOT NULL DEFAULT 'additive'
                 CHECK (change_kind IN ('additive','behavior-changing','breaking')),
  change_summary text,
  back_test_ref  uuid,
  content_hash   text        NOT NULL,
  status         text        NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','deprecated')),
  authored_by    uuid        NOT NULL,
  approved_by    uuid,
  approved_at    timestamptz,
  PRIMARY KEY (template_id, version)
);

-- ── Một version template gồm những luật nào. Member rule luôn thuộc FIRM của template
--    (owner_scope='firm', owner_id=template.firm_id); resolve() scope join theo firm_id đó.
--    Không FK tới rule_version (ref 4-cột — giữ loose như §9). ──
CREATE TABLE IF NOT EXISTS rule_registry.rule_template_member (
  template_id      uuid NOT NULL,
  template_version int  NOT NULL,
  rule_id          text NOT NULL,
  rule_version     int  NOT NULL,
  PRIMARY KEY (template_id, template_version, rule_id),
  FOREIGN KEY (template_id, template_version) REFERENCES rule_registry.rule_template_version(template_id, version) ON DELETE CASCADE
);

-- ── Khách theo template nào: bind (template, channel); pin đè channel. Append-only. ──
CREATE TABLE IF NOT EXISTS rule_registry.client_subscription (
  id             bigserial   PRIMARY KEY,
  client_id      uuid        NOT NULL,               -- không FK — qua port
  template_id    uuid        NOT NULL REFERENCES rule_registry.rule_template(id) ON DELETE CASCADE,
  channel        text        NOT NULL DEFAULT 'stable',
  pinned_version int,                                -- NULL = theo channel (LUÔN latest, §12.1)
  status         text        NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  subscribed_by  uuid        NOT NULL,
  subscribed_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_client_subscription_client ON rule_registry.client_subscription (client_id, status);

-- ── Ngoại lệ per-khách: tắt/tinh chỉnh MỘT luật kế thừa. Giữ lineage theo rule_id. ──
CREATE TABLE IF NOT EXISTS rule_registry.rule_override (
  client_id                     uuid NOT NULL,       -- không FK — qua port
  rule_id                       text NOT NULL,
  enabled                       boolean NOT NULL,    -- false = tắt cho khách
  patch                         jsonb,               -- tinh chỉnh ngưỡng/param
  acknowledged_template_version int,                 -- để cờ "re-confirm" khi template lệch
  reason                        text,
  set_by                        uuid NOT NULL,
  set_at                        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, rule_id)
);

-- ── LOCKFILE mỗi run check: bộ luật đã resolve, BẤT BIẾN (§2 tầng 3). ──
CREATE TABLE IF NOT EXISTS rule_registry.run_manifest (
  run_id        uuid        PRIMARY KEY,
  client_id     uuid        NOT NULL,
  as_of         date        NOT NULL,
  rules         jsonb       NOT NULL,                -- [{ruleId, version, source}]
  overrides     jsonb       NOT NULL DEFAULT '[]',   -- [{ruleId, kind}]
  manifest_hash text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_run_manifest_client ON rule_registry.run_manifest (client_id, as_of);
