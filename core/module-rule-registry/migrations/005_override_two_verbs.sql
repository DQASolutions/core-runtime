-- @dqa-ai-solutions/module-rule-registry · migration 005 — HAI ĐỘNG TỪ: điều chỉnh ≠ miễn trừ.
--
-- Bất biến TÁI LẬP (N6): findings của (khách, kỳ) phải tái lập được CHỈ từ base@asOf +
-- subscription + template versions + override params + waiver + fact snapshot. Cơ chế nào làm một
-- finding biến mất mà không để dấu trong danh sách đó là SAI.
--
-- `rule_override.enabled = false` trượt phép thử: luật rơi khỏi tập lúc resolve, kết quả không nói
-- gì. Bằng chứng thực nghiệm: 3/3 override thật trong DB mang lý do "bỏ áp dụng cho khách" — đó là
-- ngôn ngữ của MIỄN TRỪ. Người dùng chọn `disable` vì nó RẺ HƠN (không lý do bắt buộc, không người
-- ký, không thời hạn). Cơ chế sai thắng cơ chế đúng khi nó dễ bấm hơn ⇒ xoá cơ chế sai.
--
-- Sau migration này:
--   ĐIỀU CHỈNH = rule_override {params, severity} — luật VẪN CHẠY
--   MIỄN TRỪ   = finding_waiver (app) — kết quả bị miễn, CÓ DẤU; luật VẪN CHẠY
--
-- `enabled` KHÔNG drop ngay (giữ một release để lùi được); `resolveRuleSet` NGỪNG đọc nó, và app
-- phải backfill sang finding_waiver — nếu quên, các override cũ mất tác dụng một cách THẤY ĐƯỢC
-- (luật hiện lại trong tập) chứ không âm thầm.

ALTER TABLE rule_registry.rule_override
  ADD COLUMN IF NOT EXISTS scope    text NOT NULL DEFAULT 'client' CHECK (scope IN ('firm','client')),
  ADD COLUMN IF NOT EXISTS owner_id uuid,
  ADD COLUMN IF NOT EXISTS params   jsonb;   -- { "<param-key>": <number> } — vặn NGƯỠNG, không vá IR

UPDATE rule_registry.rule_override SET owner_id = client_id WHERE owner_id IS NULL;
ALTER TABLE rule_registry.rule_override ALTER COLUMN owner_id SET NOT NULL;

-- PK phải đổi TRƯỚC khi bỏ NOT NULL trên `client_id` (Postgres từ chối: cột nằm trong PK).
ALTER TABLE rule_registry.rule_override DROP CONSTRAINT IF EXISTS rule_override_pkey;
ALTER TABLE rule_registry.rule_override ADD  CONSTRAINT rule_override_pkey PRIMARY KEY (scope, owner_id, rule_id);

ALTER TABLE rule_registry.rule_override ALTER COLUMN client_id DROP NOT NULL;   -- deprecated

-- Điều chỉnh cũng phải giải trình (miễn trừ đã bắt buộc `reason` từ đầu).
UPDATE rule_registry.rule_override SET reason = coalesce(reason, 'chưa ghi lý do (di trú 005)');
ALTER TABLE rule_registry.rule_override ALTER COLUMN reason SET NOT NULL;

COMMENT ON COLUMN rule_registry.rule_override.enabled IS
  'DEPRECATED (mig 005). resolveRuleSet KHÔNG còn đọc. "Không áp luật" = finding_waiver. Drop sau 1 release.';
COMMENT ON COLUMN rule_registry.rule_override.params IS
  'Vặn ngưỡng qua param key. IR không bị chạm ⇒ content_hash giữ nguyên ⇒ lineage sạch (§A.3).';
