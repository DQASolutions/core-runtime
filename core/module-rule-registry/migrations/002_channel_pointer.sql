-- @dqa-ai-solutions/module-rule-registry · migration 002 — channel pointers (M3, design §2 tầng 2 / §7).
-- Tách "publish version" khỏi "roll-out": version bất biến (rule_template_version),
-- channel (stable/beta) là CON TRỎ tới version — append-only, dịch trỏ = roll-out.
-- resolve() dùng: pinned_version ?? channel_pointer ?? max(published) fallback.

CREATE TABLE IF NOT EXISTS rule_registry.channel_pointer_history (
  id           bigserial   PRIMARY KEY,
  template_id  uuid        NOT NULL REFERENCES rule_registry.rule_template(id) ON DELETE CASCADE,
  channel      text        NOT NULL,          -- 'stable' | 'beta' | ...
  version      int         NOT NULL,
  moved_by     uuid        NOT NULL,
  moved_at     timestamptz NOT NULL DEFAULT now(),
  reason       text,
  prev_version int                            -- version trước khi dịch (để audit/rollback)
);
-- "current" của (template, channel) = dòng id lớn nhất.
CREATE INDEX IF NOT EXISTS idx_channel_pointer_current
  ON rule_registry.channel_pointer_history (template_id, channel, id DESC);
