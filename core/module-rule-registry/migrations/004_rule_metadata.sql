-- @dqa-ai-solutions/module-rule-registry · migration 004 — metadata của luật thành CỘT.
--
-- Vì sao: nhãn hiển thị và căn cứ pháp lý của luật NỀN đang sống trong file .mjs được deploy
-- của app. Hệ quả: DQA sửa một cái nhãn hay gắn lại
-- điều khoản ⇒ phải commit + deploy. Toàn bộ luận điểm "base là managed DATA, không redeploy" sụp
-- tại đó. Đưa chúng thành cột thì console DQA mới là console, không phải trình sửa file nguồn.
--
-- MÙ DOMAIN: cả ba cột đều là giá trị ĐỤC với registry — kernel không diễn giải chúng.
--  · name     : nhãn người đọc ("Tiền mặt âm quỹ"). Trước đây là RULE_LABEL trong app.
--  · category : chuỗi phân loại do APP định nghĩa. KHÔNG đặt tên `level`: L1/L2/EXT/B/L3 là
--               taxonomy KẾ TOÁN, không phải khái niệm của registry. App tự ánh xạ category → nhãn tầng.
--  · cite_reviewed : căn cứ đã được chuyên gia rà chưa (cột `cite` đã có từ 001).
--
-- Tất cả NULL-able: luật cũ chưa backfill vẫn resolve bình thường (metadata không vào `expr`,
-- không đổi `content_hash`, không đổi findings).

ALTER TABLE rule_registry.rule_version
  ADD COLUMN IF NOT EXISTS name          text,
  ADD COLUMN IF NOT EXISTS category      text,
  ADD COLUMN IF NOT EXISTS cite_reviewed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN rule_registry.rule_version.category IS
  'Chuỗi đục do app định nghĩa (ví dụ: L1|L2|EXT). Registry không diễn giải.';
COMMENT ON COLUMN rule_registry.rule_version.cite IS
  'Căn cứ pháp lý dạng JSON {doc, at, kind}. `doc` trỏ một văn bản do app quản (regulation_document).';
