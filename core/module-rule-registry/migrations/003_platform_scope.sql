-- @dqa-ai-solutions/module-rule-registry · migration 003 — chủ sở hữu `platform` (inherit-model).
--
-- Vì sao: base ruleset trước đây là BẢN COPY sở-hữu-riêng của mỗi firm
-- ⇒ firm xoá được cả luật bất-biến, và luật nền của DQA bị kẹt trong silo của một firm.
-- Sau migration này base là template do PLATFORM sở hữu; firm KẾ THỪA, không sở hữu.
--
-- Ranh giới giữ nguyên: KHÔNG FK tới bảng app. `platform` tham chiếu bằng uuid hằng
-- PLATFORM_ID = '00000000-0000-0000-0000-000000000001' (KHÁC actor SYS = …0000, để audit đọc được).
-- Migration này THUẦN CẤU TRÚC — không tạo/di chuyển dữ liệu (việc đó do app làm, §8).

-- ── 1) rule_version: mở owner_scope cho 'platform' ──
ALTER TABLE rule_registry.rule_version DROP CONSTRAINT IF EXISTS rule_version_owner_scope_check;
ALTER TABLE rule_registry.rule_version ADD  CONSTRAINT rule_version_owner_scope_check
  CHECK (owner_scope IN ('platform','firm','client'));

-- ── 2) rule_template: chủ TỔNG QUÁT (owner_scope, owner_id) thay cho giả định firm_id ──
--    `firm_id` giữ lại 1 release cho khả năng lùi; mọi truy vấn mới dùng owner_*.
ALTER TABLE rule_registry.rule_template
  ADD COLUMN IF NOT EXISTS owner_scope text NOT NULL DEFAULT 'firm'
      CHECK (owner_scope IN ('platform','firm')),
  ADD COLUMN IF NOT EXISTS owner_id    uuid;

UPDATE rule_registry.rule_template SET owner_id = firm_id WHERE owner_id IS NULL;
ALTER TABLE rule_registry.rule_template ALTER COLUMN owner_id SET NOT NULL;
ALTER TABLE rule_registry.rule_template ALTER COLUMN firm_id  DROP NOT NULL;

-- UNIQUE(firm_id,key) cũ không diễn tả được template của platform (firm_id NULL).
ALTER TABLE rule_registry.rule_template DROP CONSTRAINT IF EXISTS rule_template_firm_id_key_key;
CREATE UNIQUE INDEX IF NOT EXISTS rule_template_owner_key
  ON rule_registry.rule_template (owner_scope, owner_id, key);

CREATE INDEX IF NOT EXISTS idx_rule_template_owner
  ON rule_registry.rule_template (owner_scope, owner_id);
