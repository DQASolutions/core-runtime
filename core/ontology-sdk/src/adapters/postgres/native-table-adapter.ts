// StorageAdapter over native relational tables — one table per entity type.
//
// ═══════════════════════════════════════════════════════════════════════════
// WHAT THIS CHANGES, AND WHAT IT DELIBERATELY DOES NOT
//
//   Same ontology, same StorageAdapter contract, same `v_*` view surface. The
//   only thing that moves is where a row lives: `<entity>` tables with real
//   columns instead of `instances.data jsonb`, and foreign key columns instead
//   of rows in one shared `edges` table (N..N keeps a join table of its own).
//
//   It EXTENDS PostgresAdapter rather than reimplementing it, so tenancy,
//   transactions, the onTransactionBegin seam that carries row-level security,
//   rules and events all stay byte-identical. Only the instance and edge doors
//   are overridden.
//
// ⚠️ ONE FIDELITY LOSS, STATED UP FRONT
//
//   jsonb distinguishes "key absent" from "key present, value null". A column
//   cannot: both are NULL. This adapter reads NULL back as ABSENT, because in a
//   ConditionExpr `absent` is what the vast majority of data means and because
//   `matchesProperties` treats a present null and an absent key differently
//   (`null === null` is true, `undefined === null` is false).
//
//   So a host that deliberately stores an explicit null and then compares
//   against null will see a different answer here than on the jsonb store. That
//   is a real difference, not a rounding error — it is written down here rather
//   than discovered later.
// ═══════════════════════════════════════════════════════════════════════════
import { createHash, randomUUID } from 'node:crypto'

import type {
  ConditionExpr,
  Edge,
  Instance,
  MigrationReport,
  OntologySchema,
  PropertyDef,
  Provenance,
  RelationshipTypeDef,
} from '../../types/index.js'
import type { EdgeQuery, MultiEdgeQuery, Row, StorageAdapter } from '../../ports/storage-adapter.js'
import { ontologyError, PROVENANCE_FIELDS } from '../../types/index.js'
import { matchesProperties } from '../../shared/condition-match.js'
import { PostgresAdapter, type PostgresAdapterOptions } from './postgres-adapter.js'
import { assertSafeIdentifier, buildInitDDL } from './sql.js'
import { buildNativeDDL, joinTableFor, linkPlacement, snake, tableFor } from './native-ddl.js'
import { buildNativeViewsSQL } from './native-views.js'

export interface NativeTableAdapterOptions extends PostgresAdapterOptions {
  /**
   * Required. Unlike the jsonb adapter, this one cannot be schema-agnostic: it
   * has to know a type's properties to build a column list, and a
   * relationship's cardinality to know whether the link is a column or a row.
   */
  ontology: OntologySchema
}

interface AnyRow {
  [column: string]: unknown
}

/** Same synthesis the views use, so an Edge id is stable and matches SQL. */
function synthEdgeId(relationship: string, fromId: string): string {
  const h = createHash('md5').update(`${relationship}${fromId}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

const toIso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : typeof v === 'string' ? v : new Date().toISOString()

export class NativeTableAdapter extends PostgresAdapter {
  protected readonly ontology: OntologySchema
  private readonly propsOf: Map<string, PropertyDef[]>
  private readonly relOf: Map<string, RelationshipTypeDef>

  constructor(opts: NativeTableAdapterOptions, schema = 't___default__') {
    super(opts, schema)
    this.ontology = opts.ontology
    // Provenance fields are appended to every type by the registry (NT3) and are
    // stored in their own columns, not as business properties — filter once here
    // so every read and write path below sees the same list.
    this.propsOf = new Map(
      opts.ontology.entityTypes.map((e) => [
        e.name,
        e.properties.filter((p) => !(PROVENANCE_FIELDS as readonly string[]).includes(p.name)),
      ]),
    )
    this.relOf = new Map(opts.ontology.relationshipTypes.map((r) => [r.name, r]))
  }

  /** Tenant views and transaction views must stay this type — see PostgresAdapter.spawn. */
  protected override spawn(opts: PostgresAdapterOptions, schemaName: string): StorageAdapter {
    return new NativeTableAdapter({ ...opts, ontology: this.ontology }, schemaName)
  }

  // ── Schema ──────────────────────────────────────────────────────────────────

  /**
   * The jsonb store's own tables are the two this adapter replaces, so they are
   * filtered out. Everything else buildInitDDL emits — entity_types,
   * property_defs, relationship_types, rules, events — stays: it is the metadata
   * surface tooling reads, and now that the real schema also lives in
   * information_schema the two can finally be checked against each other
   * instead of the metadata being the only truth there is.
   */
  protected override schemaDDL(schema: OntologySchema): string[] {
    return [
      ...buildInitDDL(this.schema).filter((ddl) => !/\.(instances|edges)\b/.test(ddl)),
      ...buildNativeDDL(this.schema, schema),
      ...buildNativeViewsSQL(this.schema, schema),
    ]
  }

  // ── Instances ───────────────────────────────────────────────────────────────

  private propsFor(type: string): PropertyDef[] {
    const props = this.propsOf.get(type)
    if (props === undefined) {
      throw ontologyError('UNKNOWN_ENTITY_TYPE', `Unknown entity type "${type}"`)
    }
    return props
  }

  /** Column value → the shape `data` had in the jsonb store. NULL means absent. */
  private rowToInstance(type: string, row: AnyRow): Instance {
    const data: Record<string, unknown> = {}
    for (const p of this.propsFor(type)) {
      const v = row[snake(p.name)]
      if (v === null || v === undefined) continue
      // ⚠️ node-postgres hands `numeric` back as a STRING — it refuses to lose
      //    precision silently. Left alone, a number written as 30 reads back as
      //    "30", and matchesProperties compares with === so `age = 30` stops
      //    matching. The jsonb store returned a real number, and the contract is
      //    the jsonb store's, so convert back here.
      data[p.name] =
        p.type === 'number'
          ? Number(v)
          : v instanceof Date
            ? v.toISOString()
            : v
    }
    const confirmedAt = toIso(row['confirmed_at'])
    return {
      id: row['id'] as string,
      entityType: type,
      data,
      provenance: {
        source_ref: row['source_ref'] as string,
        confirmed_by: row['confirmed_by'] as string,
        confirmed_at: confirmedAt,
      },
      source_ref: row['source_ref'] as string,
      confirmed_by: row['confirmed_by'] as string,
      confirmed_at: confirmedAt,
    }
  }

  private columnsAndValues(type: string, data: Row): { cols: string[]; vals: unknown[] } {
    const cols: string[] = []
    const vals: unknown[] = []
    for (const p of this.propsFor(type)) {
      if (!Object.hasOwn(data, p.name)) continue
      cols.push(snake(p.name))
      const v = (data as Record<string, unknown>)[p.name]
      // json must reach the driver as text or pg sends it as a record literal.
      vals.push(p.type === 'json' && v !== null && v !== undefined ? JSON.stringify(v) : v)
    }
    return { cols, vals }
  }

  override async insertInstance(type: string, data: Row, prov: Provenance): Promise<Instance> {
    assertSafeIdentifier(this.schema, 'insertInstance')
    const id = randomUUID()
    return this.writeInstance(id, type, data, prov, 'insert')
  }

  override async upsertInstance(
    id: string,
    type: string,
    data: Row,
    prov: Provenance,
  ): Promise<Instance> {
    assertSafeIdentifier(this.schema, 'upsertInstance')
    return this.writeInstance(id, type, data, prov, 'upsert')
  }

  private async writeInstance(
    id: string,
    type: string,
    data: Row,
    prov: Provenance,
    mode: 'insert' | 'upsert',
  ): Promise<Instance> {
    const table = tableFor(type)
    const { cols, vals } = this.columnsAndValues(type, data)
    const all = ['id', ...cols, 'source_ref', 'confirmed_by', 'confirmed_at']
    const params = [id, ...vals, prov.source_ref, prov.confirmed_by, prov.confirmed_at]
    const conflict =
      mode === 'upsert'
        ? ` ON CONFLICT (id) DO UPDATE SET ${[...cols, 'source_ref', 'confirmed_by', 'confirmed_at']
            .map((c) => `"${c}" = EXCLUDED."${c}"`)
            .concat('updated_at = now()')
            .join(', ')}`
        : ''
    const res = await this.exec.query<AnyRow>(
      `INSERT INTO "${this.schema}"."${table}" (${all.map((c) => `"${c}"`).join(',')})
       VALUES (${params.map((_, i) => `$${i + 1}`).join(',')})${conflict}
       RETURNING *`,
      params,
    )
    // The id → type index is what makes getInstance(id) a single lookup across
    // 80-odd tables. Written in the same statement batch so it cannot drift.
    await this.exec.query(
      `INSERT INTO "${this.schema}".instance_index (id, entity_type) VALUES ($1,$2)
       ON CONFLICT (id) DO UPDATE SET entity_type = EXCLUDED.entity_type`,
      [id, type],
    )
    const row = res.rows[0]
    if (row === undefined) throw ontologyError('MIGRATION_FAILED', 'writeInstance: no row returned')
    return this.rowToInstance(type, row)
  }

  /**
   * So-rồi-đặt trên bảng thật.
   *
   * ⚠️ `IS NOT DISTINCT FROM` chứ không phải `=`. Với `=` thì `NULL = NULL` ra
   *    NULL, nên mọi điều kiện "đang là null" sẽ lặng lẽ không bao giờ khớp —
   *    và bên gọi thấy lệnh ghi trượt mà không hiểu vì sao.
   */
  override async compareAndSetInstance(
    id: string, expected: Row, patch: Row, prov: Provenance,
  ): Promise<boolean> {
    assertSafeIdentifier(this.schema, 'compareAndSetInstance')
    const type = await this.typeOf(id)
    if (type === null) return false
    const { cols, vals } = this.columnsAndValues(type, patch)
    const exp = this.columnsAndValues(type, expected)
    const sets = [
      ...cols.map((c, i) => `"${c}" = $${i + 2}`),
      `source_ref = $${cols.length + 2}`,
      `confirmed_by = $${cols.length + 3}`,
      `confirmed_at = $${cols.length + 4}`,
      'updated_at = now()',
    ]
    const base = cols.length + 5
    const where = exp.cols.map((c, i) => `"${c}" IS NOT DISTINCT FROM $${base + i}`)
    const res = await this.exec.query(
      `UPDATE "${this.schema}"."${tableFor(type)}"
          SET ${sets.join(', ')}
        WHERE id = $1${where.length ? ' AND ' + where.join(' AND ') : ''}`,
      [id, ...vals, prov.source_ref, prov.confirmed_by, prov.confirmed_at, ...exp.vals],
    )
    return (res.rowCount ?? 0) > 0
  }

  override async updateInstance(id: string, patch: Row, prov: Provenance): Promise<Instance> {
    assertSafeIdentifier(this.schema, 'updateInstance')
    const type = await this.typeOf(id)
    if (type === null) throw ontologyError('INSTANCE_NOT_FOUND', `Instance "${id}" not found`)
    const { cols, vals } = this.columnsAndValues(type, patch)
    const sets = [
      ...cols.map((c, i) => `"${c}" = $${i + 2}`),
      `source_ref = $${cols.length + 2}`,
      `confirmed_by = $${cols.length + 3}`,
      `confirmed_at = $${cols.length + 4}`,
      'updated_at = now()',
    ]
    const res = await this.exec.query<AnyRow>(
      `UPDATE "${this.schema}"."${tableFor(type)}" SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      [id, ...vals, prov.source_ref, prov.confirmed_by, prov.confirmed_at],
    )
    const row = res.rows[0]
    if (row === undefined) throw ontologyError('INSTANCE_NOT_FOUND', `Instance "${id}" not found`)
    return this.rowToInstance(type, row)
  }

  private async typeOf(id: string): Promise<string | null> {
    const res = await this.exec.query<{ entity_type: string }>(
      `SELECT entity_type FROM "${this.schema}".instance_index WHERE id = $1`,
      [id],
    )
    return res.rows[0]?.entity_type ?? null
  }

  override async getInstance(id: string): Promise<Instance | null> {
    assertSafeIdentifier(this.schema, 'getInstance')
    const type = await this.typeOf(id)
    if (type === null) return null
    const res = await this.exec.query<AnyRow>(
      `SELECT * FROM "${this.schema}"."${tableFor(type)}" WHERE id = $1`,
      [id],
    )
    const row = res.rows[0]
    return row === undefined ? null : this.rowToInstance(type, row)
  }

  override async getInstances(ids: readonly string[]): Promise<Instance[]> {
    assertSafeIdentifier(this.schema, 'getInstances')
    const unique = [...new Set(ids)]
    if (unique.length === 0) return []
    const idx = await this.exec.query<{ id: string; entity_type: string }>(
      `SELECT id, entity_type FROM "${this.schema}".instance_index WHERE id = ANY($1::uuid[])`,
      [unique],
    )
    // Group by type so this is one query per type touched, not one per id.
    const byType = new Map<string, string[]>()
    for (const r of idx.rows) {
      const list = byType.get(r.entity_type) ?? []
      list.push(r.id)
      byType.set(r.entity_type, list)
    }
    const found = new Map<string, Instance>()
    for (const [type, typeIds] of byType) {
      const res = await this.exec.query<AnyRow>(
        `SELECT * FROM "${this.schema}"."${tableFor(type)}" WHERE id = ANY($1::uuid[])`,
        [typeIds],
      )
      for (const row of res.rows) found.set(row['id'] as string, this.rowToInstance(type, row))
    }
    // Preserve caller order, drop misses — same contract as the jsonb adapter.
    return unique.flatMap((id) => {
      const inst = found.get(id)
      return inst === undefined ? [] : [inst]
    })
  }

  override async queryInstances(type: string, cond: ConditionExpr | null): Promise<Instance[]> {
    assertSafeIdentifier(this.schema, 'queryInstances')
    // Columns are real, so the whole property-level filter could be pushed down.
    // It is NOT, on purpose: JS `>` on strings orders by UTF-16 code unit while
    // Postgres orders by collation, and on Vietnamese text those disagree.
    // Keeping matchesProperties as the decider preserves QG-5 across adapters;
    // the equality subset is pushed down for indexes and wire volume.
    const res = await this.exec.query<AnyRow>(
      `SELECT * FROM "${this.schema}"."${tableFor(type)}"`,
    )
    const instances = res.rows.map((r) => this.rowToInstance(type, r))
    if (cond === null) return instances
    return instances.filter((inst) => matchesProperties(cond, inst.data))
  }

  // ── Edges ───────────────────────────────────────────────────────────────────

  private relFor(name: string): RelationshipTypeDef {
    const rel = this.relOf.get(name)
    if (rel === undefined) {
      throw ontologyError('UNKNOWN_RELATIONSHIP_TYPE', `Unknown relationship "${name}"`)
    }
    return rel
  }

  override async insertEdge(
    relationship: string,
    fromId: string,
    toId: string,
    prov: Provenance,
  ): Promise<Edge> {
    assertSafeIdentifier(this.schema, 'insertEdge')
    const rel = this.relFor(relationship)
    const place = linkPlacement(rel)
    if (place === null) {
      await this.exec.query(
        `INSERT INTO "${this.schema}"."${joinTableFor(relationship)}"
           (from_id, to_id, source_ref, confirmed_by, confirmed_at)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (from_id, to_id) DO NOTHING`,
        [fromId, toId, prov.source_ref, prov.confirmed_by, prov.confirmed_at],
      )
    } else {
      const owner = place.side === 'from' ? fromId : toId
      const target = place.side === 'from' ? toId : fromId
      const res = await this.exec.query(
        `UPDATE "${this.schema}"."${place.table}"
            SET "${place.column}" = $1, updated_at = now()
          WHERE id = $2`,
        [target, owner],
      )
      if (res.rowCount === 0) {
        throw ontologyError('INSTANCE_NOT_FOUND', `insertEdge: instance "${owner}" not found`)
      }
    }
    return {
      id: synthEdgeId(relationship, fromId),
      relationship,
      fromId,
      toId,
      provenance: prov,
      source_ref: prov.source_ref,
      confirmed_by: prov.confirmed_by,
      confirmed_at: prov.confirmed_at,
    }
  }

  override async deleteEdge(relationship: string, fromId: string, toId: string): Promise<void> {
    assertSafeIdentifier(this.schema, 'deleteEdge')
    const place = linkPlacement(this.relFor(relationship))
    if (place === null) {
      await this.exec.query(
        `DELETE FROM "${this.schema}"."${joinTableFor(relationship)}" WHERE from_id = $1 AND to_id = $2`,
        [fromId, toId],
      )
      return
    }
    const owner = place.side === 'from' ? fromId : toId
    const target = place.side === 'from' ? toId : fromId
    // Only clear when it still points where the caller thinks it does —
    // otherwise a stale delete would silently unlink a newer, different link.
    await this.exec.query(
      `UPDATE "${this.schema}"."${place.table}"
          SET "${place.column}" = NULL, updated_at = now()
        WHERE id = $1 AND "${place.column}" = $2`,
      [owner, target],
    )
  }

  override async queryEdges(spec: EdgeQuery): Promise<Edge[]> {
    return this.readEdges({
      ...(spec.relationship !== undefined ? { relationship: spec.relationship } : {}),
      ...(spec.fromId !== undefined ? { fromIds: [spec.fromId] } : {}),
      ...(spec.toId !== undefined ? { toIds: [spec.toId] } : {}),
    })
  }

  override async queryEdgesMulti(spec: MultiEdgeQuery): Promise<Edge[]> {
    return this.readEdges(spec)
  }

  /**
   * One reader for both edge doors. Without a relationship name every
   * relationship has to be visited, because there is no longer one table that
   * holds them all — the cost of typed storage, paid only by callers that ask
   * an untyped question.
   */
  private async readEdges(spec: MultiEdgeQuery): Promise<Edge[]> {
    assertSafeIdentifier(this.schema, 'queryEdges')
    if (spec.fromIds?.length === 0 || spec.toIds?.length === 0) return []
    const rels =
      spec.relationship === undefined
        ? this.ontology.relationshipTypes
        : [this.relFor(spec.relationship)]
    const out: Edge[] = []
    for (const rel of rels) {
      const place = linkPlacement(rel)
      const where: string[] = []
      const params: unknown[] = []
      const add = (col: string, ids: readonly string[] | undefined): void => {
        if (ids === undefined) return
        params.push([...ids])
        where.push(`${col} = ANY($${params.length}::uuid[])`)
      }
      if (place === null) {
        add('from_id', spec.fromIds)
        add('to_id', spec.toIds)
        const res = await this.exec.query<AnyRow>(
          `SELECT from_id, to_id, source_ref, confirmed_by, confirmed_at
             FROM "${this.schema}"."${joinTableFor(rel.name)}"
            ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}`,
          params,
        )
        for (const r of res.rows) out.push(this.rowToEdge(rel.name, r['from_id'] as string, r['to_id'] as string, r))
        continue
      }
      const selfCol = 'id'
      const otherCol = place.column
      // `from` on the row is whichever end the column owner represents.
      const fromExpr = place.side === 'from' ? selfCol : otherCol
      const toExpr = place.side === 'from' ? otherCol : selfCol
      add(fromExpr, spec.fromIds)
      add(toExpr, spec.toIds)
      const res = await this.exec.query<AnyRow>(
        `SELECT ${fromExpr} AS from_id, ${toExpr} AS to_id, source_ref, confirmed_by, confirmed_at
           FROM "${this.schema}"."${place.table}"
          WHERE "${otherCol}" IS NOT NULL${where.length > 0 ? ` AND ${where.join(' AND ')}` : ''}`,
        params,
      )
      for (const r of res.rows) out.push(this.rowToEdge(rel.name, r['from_id'] as string, r['to_id'] as string, r))
    }
    return out
  }

  private rowToEdge(relationship: string, fromId: string, toId: string, row: AnyRow): Edge {
    const confirmedAt = toIso(row['confirmed_at'])
    const prov: Provenance = {
      source_ref: row['source_ref'] as string,
      confirmed_by: row['confirmed_by'] as string,
      confirmed_at: confirmedAt,
    }
    return {
      id: synthEdgeId(relationship, fromId),
      relationship,
      fromId,
      toId,
      provenance: prov,
      source_ref: prov.source_ref,
      confirmed_by: prov.confirmed_by,
      confirmed_at: confirmedAt,
    }
  }
}
