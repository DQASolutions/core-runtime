/**
 * Action runtime (E1.1): governed write verbs — applyAction + guard
 * (submission-criteria) + built-in createInstance/link, emitting events.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createOntology, InMemoryAdapter, OntologyError, type Ontology } from '../../src/index.js'
import type { StorageAdapter, UnitOfWork } from '../../src/ports/storage-adapter.js'

const ctx = { tenantId: 't1' }
const prov = { source_ref: 'src', confirmed_by: 'u', confirmed_at: '2026-01-01T00:00:00.000Z' }

let ont: Ontology

beforeEach(async () => {
  ont = createOntology({ adapter: new InMemoryAdapter() })
  await ont.defineEntityType({ name: 'doc', label: 'Doc', properties: [] }, ctx)
})

async function rejectsWith(p: Promise<unknown>, code: string) {
  let caught: unknown
  try { await p } catch (e) { caught = e }
  expect(caught).toBeInstanceOf(OntologyError)
  expect((caught as OntologyError).code).toBe(code)
}

describe('applyAction — built-in createInstance', () => {
  it('creates an instance and emits a stamped event', async () => {
    const events = await ont.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx)
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('instance.created')
    expect(events[0]!.aggregate).toMatch(/.+/)
    expect(events[0]!.actor).toBe('system') // ctx has no actor

    const found = await ont.find('doc', undefined, ctx)
    expect(found).toHaveLength(1)
    expect(found[0]!.id).toBe(events[0]!.aggregate)
  })

  it('carries ctx.actor onto the event', async () => {
    const events = await ont.applyAction('createInstance', { type: 'doc', props: {} }, prov, { tenantId: 't1', actor: 'alice' })
    expect(events[0]!.actor).toBe('alice')
  })

  it('requires provenance', async () => {
    await rejectsWith(
      ont.applyAction('createInstance', { type: 'doc', props: {} }, { source_ref: '', confirmed_by: '', confirmed_at: '' }, ctx),
      'PROVENANCE_MISSING',
    )
  })

  it('rejects an unknown action', async () => {
    await rejectsWith(ont.applyAction('nope', {}, prov, ctx), 'ACTION_NOT_FOUND')
  })
})

describe('applyAction — app-defined actions + guard', () => {
  it('runs an app effect through the governed IO surface', async () => {
    await ont.defineActionImpl(
      {
        def: { name: 'fileDoc' },
        effect: async (args, _c, io) => {
          const { id } = await io.create('doc', {})
          return [{ type: 'doc.filed', aggregate: id, payload: { label: args.label ?? null } }]
        },
      },
      ctx,
    )
    const events = await ont.applyAction('fileDoc', { label: 'q1' }, prov, ctx)
    expect(events[0]!.type).toBe('doc.filed')
    expect((await ont.find('doc', undefined, ctx))).toHaveLength(1)
  })

  it('rejects when the guard (submission-criteria) fails', async () => {
    await ont.defineActionImpl(
      {
        def: { name: 'risky' },
        guard: (args) => ({ ok: args.allowed === true, reason: 'not allowed' }),
        effect: async () => [],
      },
      ctx,
    )
    await rejectsWith(ont.applyAction('risky', { allowed: false }, prov, ctx), 'ACTION_GUARD_FAILED')
    // passes the guard when criteria met
    const ev = await ont.applyAction('risky', { allowed: true }, prov, ctx)
    expect(ev).toEqual([])
  })

  it('a declared-but-unbound action throws ACTION_NOT_BOUND', async () => {
    await ont.defineAction({ name: 'bare', params: { x: { type: 'string' } } }, ctx)
    await rejectsWith(ont.applyAction('bare', { x: 'a' }, prov, ctx), 'ACTION_NOT_BOUND')
  })
})

/**
 * Attaching a thing and later detaching it is the ordinary life of a record —
 * a unit committed to an incident then stood down, a document filed then pulled.
 * The write door used to open one way only, which left "take it back out" with
 * nowhere governed to go.
 */
describe('applyAction — built-in unlink', () => {
  beforeEach(async () => {
    await ont.defineRelationshipType({ name: 'cites', from: 'doc', to: 'doc', cardinality: 'N..N', directed: true }, ctx)
  })

  /** Two docs and an edge between them; returns [fromId, toId]. */
  async function linked(): Promise<[string, string]> {
    const a = await ont.create('doc', {}, prov, ctx)
    const b = await ont.create('doc', {}, prov, ctx)
    await ont.applyAction('link', { relationship: 'cites', from: a.id, to: b.id }, prov, ctx)
    return [a.id, b.id]
  }

  it('removes the edge and emits a stamped event', async () => {
    const [a, b] = await linked()
    expect(await ont.neighbors(a, 'cites', ctx)).toHaveLength(1)

    const events = await ont.applyAction('unlink', { relationship: 'cites', from: a, to: b }, prov, ctx)
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('edge.removed')
    expect(events[0]!.aggregate).toBe(a)
    expect(events[0]!.payload).toEqual({ relationship: 'cites', to: b })

    expect(await ont.neighbors(a, 'cites', ctx)).toHaveLength(0)
  })

  it('requires provenance, like every other write', async () => {
    const [a, b] = await linked()
    await rejectsWith(
      ont.applyAction('unlink', { relationship: 'cites', from: a, to: b }, { source_ref: '', confirmed_by: '', confirmed_at: '' }, ctx),
      'PROVENANCE_MISSING',
    )
  })

  // Detaching what was never attached is a mistake in the caller, not a no-op:
  // silence here would let a stand-down report success against the wrong unit.
  it('refuses an edge that is not there', async () => {
    const a = await ont.create('doc', {}, prov, ctx)
    const b = await ont.create('doc', {}, prov, ctx)
    await rejectsWith(
      ont.applyAction('unlink', { relationship: 'cites', from: a.id, to: b.id }, prov, ctx),
      'INSTANCE_NOT_FOUND',
    )
  })

  it('is reachable from an app-defined effect through io.unlink', async () => {
    const [a, b] = await linked()
    await ont.defineActionImpl(
      {
        def: { name: 'standDown' },
        effect: async (args, _c, io) => {
          await io.unlink('cites', String(args.from), String(args.to))
          return [{ type: 'doc.standDown', aggregate: String(args.from), payload: null }]
        },
      },
      ctx,
    )
    const events = await ont.applyAction('standDown', { from: a, to: b }, prov, ctx)
    expect(events[0]!.type).toBe('doc.standDown')
    expect(await ont.neighbors(a, 'cites', ctx)).toHaveLength(0)
  })

  // ⚠️ The removal must run on the transaction's own adapter, like every other
  //    write in the effect. Asserting "the edge came back after a throw" does
  //    NOT prove that: InMemoryAdapter rolls back by restoring the shared tenant
  //    bucket, so the test passes either way and proves nothing. On Postgres a
  //    non-transactional view is a different connection, and the removal would
  //    commit while the rest of the effect rolled back. So watch WHERE the
  //    deleteEdge landed instead — that reads the same on every adapter.
  it('removes the edge on the transaction adapter, not a fresh view', async () => {
    const seen: string[] = []
    const watch = (target: StorageAdapter, where: string): StorageAdapter =>
      new Proxy(target, {
        get(t, prop) {
          if (prop === 'deleteEdge') {
            return (...args: [string, string, string]) => {
              seen.push(where)
              return t.deleteEdge(...args)
            }
          }
          if (prop === 'withTenant') return (tid: string) => watch(t.withTenant(tid), 'fresh view')
          if (prop === 'withTransaction' && t.withTransaction) {
            return (fn: (uow: UnitOfWork) => Promise<unknown>) =>
              t.withTransaction!((uow) => fn({ ...uow, adapter: watch(uow.adapter, 'transaction') }))
          }
          const v = Reflect.get(t, prop, t)
          return typeof v === 'function' ? v.bind(t) : v
        },
      }) as StorageAdapter

    const watched = createOntology({ adapter: watch(new InMemoryAdapter(), 'fresh view') })
    await watched.defineEntityType({ name: 'doc', label: 'Doc', properties: [] }, ctx)
    await watched.defineRelationshipType({ name: 'cites', from: 'doc', to: 'doc', cardinality: 'N..N', directed: true }, ctx)
    const a = await watched.create('doc', {}, prov, ctx)
    const b = await watched.create('doc', {}, prov, ctx)
    await watched.applyAction('link', { relationship: 'cites', from: a.id, to: b.id }, prov, ctx)

    await watched.applyAction('unlink', { relationship: 'cites', from: a.id, to: b.id }, prov, ctx)
    expect(seen).toEqual(['transaction'])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ⭐ MỘT ĐƠN VỊ CÔNG VIỆC CHO NHIỀU LƯỢT GHI — thêm 5/9/2026.
//
//   Không có nó thì mỗi `applyAction` là một giao dịch riêng, và host không
//   ghép được một phép đọc-rồi-ghi của mình vào cùng giao dịch với hiệu ứng.
//   Đo ở app tham chiếu: đường chia chỉ tiêu đọc tổng đã chia trên một lượt rồi
//   ghi ở lượt khác — hai người chia cùng lúc thì cả hai qua cửa và chỉ tiêu
//   500 bị chia 600.
// ═══════════════════════════════════════════════════════════════════════════
describe('withUnitOfWork — ghép nhiều lượt ghi vào một giao dịch', () => {
  /**
   * Adapter đếm giao dịch.
   *
   * ⚠️ PHẢI ĐÈ CẢ `withTenant`. Bản gốc trả về `new InMemoryAdapter(...)`, tức
   *    là lớp con BIẾN MẤT ngay khi `applyAction` gọi `withTenant` — và phép
   *    thử đo một adapter khác cái mình dựng. Đúng cái bẫy `PostgresAdapter`
   *    đã cảnh báo ở chú thích `spawn()`: "silently degrading to a plain
   *    adapter mid-transaction". `InMemoryAdapter` chưa có `spawn`, nên đè tay.
   */
  class TxAdapter extends InMemoryAdapter {
    txDepth = 0
    committed = 0
    rolledBack = 0
    override withTenant(_t: string): StorageAdapter { return this as unknown as StorageAdapter }
    override async withTransaction<T>(fn: (uow: UnitOfWork) => Promise<T>): Promise<T> {
      this.txDepth += 1
      try {
        const out = await fn({ tenantId: 't1', adapter: this as unknown as StorageAdapter, raw: { marker: 'tx' } })
        this.committed += 1
        return out
      } catch (e) { this.rolledBack += 1; throw e } finally { this.txDepth -= 1 }
    }
  }

  it('hai lượt ghi trong một `withUnitOfWork` chỉ mở ĐÚNG MỘT giao dịch', async () => {
    const ad = new TxAdapter()
    const o = createOntology({ adapter: ad })
    await o.defineEntityType({ name: 'doc', label: 'Doc', properties: [] }, ctx)
    const before = ad.committed
    await o.withUnitOfWork(async (uow) => {
      await o.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx, uow)
      await o.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx, uow)
    }, ctx)
    // Một giao dịch cho cả hai lượt — không phải hai.
    expect(ad.committed - before).toBe(1)
    expect(await o.find('doc', undefined, ctx)).toHaveLength(2)
  })

  it('không truyền `uow` thì y như cũ — mỗi lượt một giao dịch', async () => {
    const ad = new TxAdapter()
    const o = createOntology({ adapter: ad })
    await o.defineEntityType({ name: 'doc', label: 'Doc', properties: [] }, ctx)
    const before = ad.committed
    await o.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx)
    await o.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx)
    expect(ad.committed - before).toBe(2)
  })

  it('⛔ hỏng giữa chừng thì CẢ LƯỢT lùi lại — không có nửa vời', async () => {
    const ad = new TxAdapter()
    const o = createOntology({ adapter: ad })
    await o.defineEntityType({ name: 'doc', label: 'Doc', properties: [] }, ctx)
    const before = ad.rolledBack
    await expect(o.withUnitOfWork(async (uow) => {
      await o.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx, uow)
      throw new Error('host đổi ý giữa chừng')
    }, ctx)).rejects.toThrow(/đổi ý/)
    expect(ad.rolledBack - before).toBe(1)
  })

  it('⛔ `uow` dựng tay bị TỪ CHỐI — hàng rào phạm vi chưa chạy', async () => {
    const ad = new TxAdapter()
    const o = createOntology({ adapter: ad })
    await o.defineEntityType({ name: 'doc', label: 'Doc', properties: [] }, ctx)
    const fakeDeps = { tenantId: 't1', adapter: ad as unknown as StorageAdapter }
    await rejectsWith(
      o.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx, fakeDeps as never),
      'MIGRATION_FAILED')
  })

  it('`uow` do `withUnitOfWork` trao ra thì mang dấu và đi qua được', async () => {
    const ad = new TxAdapter()
    const o = createOntology({ adapter: ad })
    await o.defineEntityType({ name: 'doc', label: 'Doc', properties: [] }, ctx)
    const ev = await o.withUnitOfWork((uow) =>
      o.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx, uow), ctx)
    expect(ev).toHaveLength(1)
  })

  it('`uow.raw` trao ra chỗ host chạy SQL riêng, cùng giao dịch ấy', async () => {
    const ad = new TxAdapter()
    const o = createOntology({ adapter: ad })
    let seen: unknown
    await o.withUnitOfWork(async (uow) => { seen = (uow as UnitOfWork).raw }, ctx)
    expect(seen).toEqual({ marker: 'tx' })
  })

  it('lượt ghi trong `uow` vẫn đóng dấu tên bước và vẫn vào sổ sự kiện', async () => {
    const ad = new TxAdapter()
    const o = createOntology({ adapter: ad })
    await o.defineEntityType({ name: 'doc', label: 'Doc', properties: [] }, ctx)
    const events = await o.withUnitOfWork((uow) =>
      o.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx, uow), ctx)
    expect(events).toHaveLength(1)
    expect(events[0]!.action).toBe('createInstance')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// ⭐ LỖI BỌC PHẢI GIỮ NGUYÊN NHÂN — 5/9/2026.
//
//   `migrate()` bọc mọi lỗi adapter thành một câu chung và trước đây VỨT bản
//   gốc. Lời báo duy nhất là "the storage adapter rejected the schema apply
//   operation" — không bảng, không cột, không câu SQL. Hai phiên mất một buổi
//   tối vì nó. Nay thông điệp vẫn chung chung (BR-013), nguyên nhân đi kèm ở
//   `cause`.
// ═══════════════════════════════════════════════════════════════════════════
describe('migrate — lỗi bọc giữ nguyên nhân, không rò ruột ra thông điệp', () => {
  const failing = (boom: Error) => {
    const inner = new InMemoryAdapter()
    return {
      ...inner,
      withTenant(tid: string) {
        const view = inner.withTenant(tid)
        return { ...view, applySchema: async () => { throw boom } } as unknown as StorageAdapter
      },
    } as unknown as StorageAdapter
  }

  it('giữ nguyên nhân ở `cause` — moi ra được bảng nào, cột nào', async () => {
    const boom = new Error('column "catalogue" of relation "property_defs" does not exist')
    const o = createOntology({ adapter: failing(boom) })
    let caught: unknown
    try { await o.migrate(ctx) } catch (e) { caught = e }
    expect((caught as OntologyError).code).toBe('MIGRATION_FAILED')
    expect((caught as Error).cause).toBe(boom)
    expect(String((caught as Error).cause)).toMatch(/property_defs/)
  })

  it('⛔ THÔNG ĐIỆP vẫn không mang ruột adapter — BR-013 giữ nguyên', async () => {
    const boom = new Error('column "catalogue" of relation "property_defs" does not exist')
    const o = createOntology({ adapter: failing(boom) })
    let caught: unknown
    try { await o.migrate(ctx) } catch (e) { caught = e }
    expect((caught as Error).message).not.toMatch(/catalogue|property_defs|column/)
    expect((caught as Error).message).toMatch(/rejected the schema apply operation/)
  })
})
