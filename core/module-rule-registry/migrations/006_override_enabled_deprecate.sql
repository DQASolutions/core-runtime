-- @dqa-ai-solutions/module-rule-registry · migration 006 — `enabled` thành cột CHẾT hẳn (chuẩn bị DROP).
--
-- 005 ngừng ĐỌC `enabled` nhưng cột vẫn NOT NULL không default ⇒ mọi writer mới vẫn bị bắt điền
-- một cột không còn ý nghĩa. Đó là cách một khái niệm đã xoá vẫn sống dai trong code gọi.
-- Cho nó default + nullable: writer mới quên nó cũng đúng. DROP ở release sau.
ALTER TABLE rule_registry.rule_override ALTER COLUMN enabled SET DEFAULT true;
ALTER TABLE rule_registry.rule_override ALTER COLUMN enabled DROP NOT NULL;
