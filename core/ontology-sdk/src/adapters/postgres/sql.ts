// Layer 1 — SQL DDL helpers for PostgresAdapter.
// All DDL is parameterized-safe: only IDENTIFIER fragments appear as template
// literals, and each one is validated against /^[a-zA-Z0-9_]+$/ before use.
// No value ever lands in a template string (C-004).

import { PROPERTY_TYPES, RULE_KINDS } from '../../types/concepts.js'

/**
 * The rule-kind CHECK list, built from the single source of truth in
 * types/concepts.ts. Every kind is a compile-time literal from a frozen tuple —
 * nothing caller-supplied reaches this string (C-004 holds).
 *
 * Named constraint (not inline) so an existing schema can have it replaced when
 * the list grows; see `buildMigrationDDL`.
 */
const RULE_KIND_LIST = RULE_KINDS.map((k) => `'${k}'`).join(',')
const PROPERTY_TYPE_LIST = PROPERTY_TYPES.map((t) => `'${t}'`).join(',')

/**
 * Derive a safe Postgres schema identifier from a tenantId. Prefix `t_` ensures
 * the result never begins with a digit; any char outside [a-zA-Z0-9_] → `_`.
 * Shared by PostgresAdapter (graph) and PostgresEventStore (events) so both
 * resolve a tenant to the SAME schema.
 */
export function toSchemaName(tenantId: string): string {
  return `t_${tenantId.replace(/[^a-zA-Z0-9_]/g, '_')}`
}

/** Throw if `name` contains any character outside [a-zA-Z0-9_]. */
export function assertSafeIdentifier(name: string, context: string): void {
  if (!/^[a-zA-Z0-9_]+$/.test(name)) {
    throw new Error(
      `[MIGRATION_FAILED] Unsafe identifier "${name}" in ${context}. ` +
        'Only [a-zA-Z0-9_] characters are allowed.',
    )
  }
}

/**
 * Return all CREATE TABLE + INDEX statements for a single tenant schema.
 * `schema` has already been validated as a safe identifier by the caller.
 */
export function buildInitDDL(schema: string): string[] {
  const s = `"${schema}"`
  return [
    // Enable pgcrypto — idempotent, needed if gen_random_uuid() is used in DDL
    // (we generate UUIDs in JS via randomUUID, but this is a zero-cost safeguard)
    `CREATE EXTENSION IF NOT EXISTS pgcrypto`,

    `CREATE SCHEMA IF NOT EXISTS ${s}`,

    // entity_types
    `CREATE TABLE IF NOT EXISTS ${s}.entity_types (
      id          uuid        NOT NULL DEFAULT gen_random_uuid(),
      name        text        NOT NULL,
      label       text        NOT NULL,
      source_ref  text        NOT NULL CHECK (length(trim(source_ref)) > 0),
      confirmed_by text       NOT NULL CHECK (length(trim(confirmed_by)) > 0),
      confirmed_at timestamptz NOT NULL,
      CONSTRAINT pk_entity_types PRIMARY KEY (id),
      CONSTRAINT uq_entity_types_name UNIQUE (name)
    )`,

    // property_defs
    `CREATE TABLE IF NOT EXISTS ${s}.property_defs (
      id             uuid    NOT NULL DEFAULT gen_random_uuid(),
      entity_type_id uuid    NOT NULL,
      name           text    NOT NULL,
      type           text    NOT NULL CHECK (type IN (${PROPERTY_TYPE_LIST})),
      enum_values    jsonb,
      catalogue      text,
      required       boolean NOT NULL DEFAULT false,
      description    text,
      CONSTRAINT pk_property_defs PRIMARY KEY (id),
      CONSTRAINT uq_property_defs_type_name UNIQUE (entity_type_id, name),
      CONSTRAINT fk_property_defs_entity_type FOREIGN KEY (entity_type_id)
        REFERENCES ${s}.entity_types (id) ON DELETE CASCADE
    )`,

    // relationship_types
    `CREATE TABLE IF NOT EXISTS ${s}.relationship_types (
      id           uuid        NOT NULL DEFAULT gen_random_uuid(),
      name         text        NOT NULL,
      from_type    text        NOT NULL,
      to_type      text        NOT NULL,
      cardinality  text        NOT NULL CHECK (cardinality IN ('1..1','1..N','N..1','N..N')),
      directed     boolean     NOT NULL,
      description  text,
      source_ref   text        NOT NULL CHECK (length(trim(source_ref)) > 0),
      confirmed_by text        NOT NULL CHECK (length(trim(confirmed_by)) > 0),
      confirmed_at timestamptz NOT NULL,
      CONSTRAINT pk_relationship_types PRIMARY KEY (id),
      CONSTRAINT uq_relationship_types_name UNIQUE (name)
    )`,

    // instances
    `CREATE TABLE IF NOT EXISTS ${s}.instances (
      id           uuid        NOT NULL,
      entity_type  text        NOT NULL,
      data         jsonb       NOT NULL DEFAULT '{}',
      source_ref   text        NOT NULL CHECK (length(trim(source_ref)) > 0),
      confirmed_by text        NOT NULL CHECK (length(trim(confirmed_by)) > 0),
      confirmed_at timestamptz NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now(),
      updated_at   timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_instances PRIMARY KEY (id)
    )`,

    // edges
    `CREATE TABLE IF NOT EXISTS ${s}.edges (
      id           uuid        NOT NULL,
      rel          text        NOT NULL,
      from_id      uuid        NOT NULL,
      to_id        uuid        NOT NULL,
      source_ref   text        NOT NULL CHECK (length(trim(source_ref)) > 0),
      confirmed_by text        NOT NULL CHECK (length(trim(confirmed_by)) > 0),
      confirmed_at timestamptz NOT NULL,
      created_at   timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_edges PRIMARY KEY (id),
      CONSTRAINT uq_edges_rel_from_to UNIQUE (rel, from_id, to_id),
      CONSTRAINT fk_edges_from FOREIGN KEY (from_id)
        REFERENCES ${s}.instances (id),
      CONSTRAINT fk_edges_to FOREIGN KEY (to_id)
        REFERENCES ${s}.instances (id)
    )`,

    // rules  (id is text — RuleDef.id is caller-supplied)
    `CREATE TABLE IF NOT EXISTS ${s}.rules (
      id           text        NOT NULL,
      name         text        NOT NULL,
      kind         text        NOT NULL
        CONSTRAINT ck_rules_kind CHECK (kind IN (${RULE_KIND_LIST})),
      applies_to   text        NOT NULL,
      condition    jsonb       NOT NULL,
      severity     text        NOT NULL,
      message      text        NOT NULL,
      enabled      boolean     NOT NULL DEFAULT true,
      version      integer     NOT NULL DEFAULT 1,
      source_ref   text        NOT NULL CHECK (length(trim(source_ref)) > 0),
      confirmed_by text        NOT NULL CHECK (length(trim(confirmed_by)) > 0),
      confirmed_at timestamptz NOT NULL,
      CONSTRAINT pk_rules PRIMARY KEY (id)
    )`,

    // events — the durable system-of-record change log (M2). Append-only:
    // never UPDATE/DELETE. `seq` gives tenant-global replay order; (aggregate_id,
    // version) is the per-aggregate history (PK enforces no version gaps/dupes).
    // prev_hash/hash reserved for the tamper-evident chain (M2b).
    `CREATE TABLE IF NOT EXISTS ${s}.events (
      seq          bigserial   NOT NULL,
      id           text        NOT NULL,
      aggregate_id uuid        NOT NULL,
      version      integer     NOT NULL,
      type         text        NOT NULL,
      payload      jsonb,
      actor        text        NOT NULL,
      ts           timestamptz NOT NULL,
      prev_hash    text,
      hash         text,
      -- action: BUOC nao sinh ra su kien nay. Kernel la ben duy nhat biet chac,
      -- vi no la ben ap buoc. Thieu cot nay thi phat lai nhat ky qua do thi quy
      -- trinh phai DOAN theo quy uoc dat ten type, va doan thi hong.
      action       text,
      CONSTRAINT pk_events PRIMARY KEY (aggregate_id, version),
      CONSTRAINT uq_events_seq UNIQUE (seq)
    )`,

    // ⚠️ CỘNG THÊM CỘT CHO KHO ĐÃ CHẠY. `CREATE TABLE IF NOT EXISTS` không đụng
    //    tới bảng đã tồn tại, nên kho dựng trước bản này sẽ THIẾU cột `action` và
    //    lệnh chèn gãy ngay lượt ghi đầu. Thêm rời, idempotent.
    `ALTER TABLE ${s}.events ADD COLUMN IF NOT EXISTS action text`,

    // indexes — all IF NOT EXISTS so applySchema is idempotent
    `CREATE INDEX IF NOT EXISTS idx_instances_type
      ON ${s}.instances (entity_type)`,

    `CREATE INDEX IF NOT EXISTS idx_events_seq
      ON ${s}.events (seq)`,

    `CREATE INDEX IF NOT EXISTS idx_edges_from_rel
      ON ${s}.edges (from_id, rel)`,

    `CREATE INDEX IF NOT EXISTS idx_edges_to_rel
      ON ${s}.edges (to_id, rel)`,

    `CREATE INDEX IF NOT EXISTS idx_rules_applies_enabled
      ON ${s}.rules (applies_to, enabled)`,

    // ── Bring an ALREADY-PROVISIONED schema up to date ───────────────────────
    //
    // CREATE TABLE IF NOT EXISTS leaves an existing table's constraints alone,
    // so a schema provisioned before a rule kind was added keeps rejecting it.
    // Re-stating the CHECK makes the constraint follow RULE_KINDS on every
    // applySchema instead of only on first provisioning.
    //
    // Two DROPs: `rules_kind_check` is the name Postgres auto-assigned when the
    // constraint was inline, `ck_rules_kind` is the explicit name used now —
    // dropping both is what makes re-running this idempotent.
    `ALTER TABLE ${s}.rules DROP CONSTRAINT IF EXISTS rules_kind_check`,
    `ALTER TABLE ${s}.rules DROP CONSTRAINT IF EXISTS ck_rules_kind`,
    `ALTER TABLE ${s}.rules
       ADD CONSTRAINT ck_rules_kind CHECK (kind IN (${RULE_KIND_LIST}))`,

    // ── Bảng SIÊU DỮ LIỆU CŨNG PHẢI NÂNG ĐƯỢC ────────────────────────────────
    //
    // ⛔ `CREATE TABLE IF NOT EXISTS` chỉ đúng cho kho MỚI. Bảng đã có thì câu ấy
    //    là no-op, nên một cột thêm vào định nghĩa KHÔNG BAO GIỜ tới được kho đã
    //    dựng — rồi lượt `INSERT` kế tiếp đâm vào cột không tồn tại.
    //
    //    Đo được 5/9/2026 ở app tham chiếu: 5.9.0 thêm `property_defs.catalogue`;
    //    mọi kho dựng trước đó chết ở `applySchema` với
    //    `column "catalogue" of relation "property_defs" does not exist`. Một
    //    buổi tối của hai phiên để tìm ra, phần lớn vì lỗi thật bị nuốt (xem
    //    `api/ontology.ts`, chỗ ném MIGRATION_FAILED).
    //
    // ⭐ CÙNG LỐI ĐÃ DÙNG CHO `rules.kind` NGAY TRÊN: nêu lại ở MỖI lượt
    //    `applySchema`, không chỉ lúc dựng lần đầu. Ở đó là một `CHECK`, ở đây
    //    là một cột — cùng một bài học, chỉ khác hình dạng, và bài ấy đã học
    //    một lần rồi mà không ai áp sang bảng bên cạnh.
    `ALTER TABLE ${s}.property_defs ADD COLUMN IF NOT EXISTS catalogue text`,
    // Hai DROP: tên Postgres tự đặt khi CHECK viết inline, và tên tường minh
    // dùng từ nay — bỏ cả hai mới chạy lại được nhiều lần.
    `ALTER TABLE ${s}.property_defs DROP CONSTRAINT IF EXISTS property_defs_type_check`,
    `ALTER TABLE ${s}.property_defs DROP CONSTRAINT IF EXISTS ck_property_defs_type`,
    `ALTER TABLE ${s}.property_defs
       ADD CONSTRAINT ck_property_defs_type CHECK (type IN (${PROPERTY_TYPE_LIST}))`,
  ]
}
