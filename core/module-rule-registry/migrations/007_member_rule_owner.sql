-- @dqa-ai-solutions/module-rule-registry · migration 007 — member mang CHỦ CỦA LUẬT.
--
-- Vì sao: hôm nay chủ của một luật trong template được SUY RA từ chủ của template
--   (`rv.owner_scope = t.owner_scope AND rv.owner_id = t.owner_id`).
-- Suy diễn ấy gói hai khái niệm khác nhau vào một:
--   · AI SỞ HỮU LUẬT   — ai soạn ra nó, ai chịu trách nhiệm về nội dung;
--   · AI LẮP BỘ LUẬT   — ai chọn dùng luật nào cho khách của mình.
-- Chừng nào chúng còn dính nhau, một hãng KHÔNG THỂ lắp luật của DQA vào bộ luật của mình —
-- mà đó chính là mô hình sản phẩm: DQA sở hữu tri thức, hãng sở hữu dịch vụ.
--
-- Tách ra: member tự khai chủ của luật nó trỏ tới. Bộ luật của hãng nay chứa được luật
-- `platform` (lấy từ Thư viện quy định) lẫn luật `firm` (kệ riêng của hãng), trộn tự do.
--
-- Backfill = chủ của template ⇒ ngữ nghĩa cũ được BẢO TOÀN chính xác: mọi member đang có
-- vốn dĩ trỏ luật cùng chủ với template. Không hàng nào đổi nghĩa.
--
-- KHÔNG cho 'client': luật riêng của khách resolve THẲNG (owner_scope='client' ở getResolveInputs),
-- không đi qua template. Cho nó vào đây là mở một đường thứ hai tới cùng một đích.

ALTER TABLE rule_registry.rule_template_member
  ADD COLUMN IF NOT EXISTS rule_owner_scope text,
  ADD COLUMN IF NOT EXISTS rule_owner_id    uuid;

UPDATE rule_registry.rule_template_member m
   SET rule_owner_scope = t.owner_scope, rule_owner_id = t.owner_id
  FROM rule_registry.rule_template t
 WHERE t.id = m.template_id AND m.rule_owner_scope IS NULL;

ALTER TABLE rule_registry.rule_template_member
  ALTER COLUMN rule_owner_scope SET NOT NULL,
  ALTER COLUMN rule_owner_id    SET NOT NULL;

ALTER TABLE rule_registry.rule_template_member
  DROP CONSTRAINT IF EXISTS rule_template_member_rule_owner_scope_check;
ALTER TABLE rule_registry.rule_template_member
  ADD CONSTRAINT rule_template_member_rule_owner_scope_check
  CHECK (rule_owner_scope IN ('platform', 'firm'));

-- Truy vấn nóng của resolve: member → rule_version theo (rule_id, version, chủ).
CREATE INDEX IF NOT EXISTS rule_template_member_rule_owner
  ON rule_registry.rule_template_member (rule_owner_scope, rule_owner_id, rule_id, rule_version);

COMMENT ON COLUMN rule_registry.rule_template_member.rule_owner_scope IS
  'CHỦ CỦA LUẬT, độc lập với chủ của template. Bộ luật của hãng chứa được luật platform (thư viện DQA).';
