import { describe, it, expect } from 'vitest'
import { publishTemplateVersion, moveChannel, rollbackChannel } from './service.js'

function fakeStore(opts: { meta?: any; pointer?: any } = {}) {
  const published: any[] = [], moves: any[] = []
  let pointer = opts.pointer ?? null
  const store: any = {
    getTemplateVersionMeta: async () => opts.meta ?? null,
    publishTemplateVersion: async (t: string, v: number, by: string) => { published.push({ t, v, by }) },
    currentChannelPointer: async () => pointer,
    moveChannel: async (m: any) => { moves.push(m); pointer = { version: m.version, prevVersion: m.prevVersion } },
  }
  return { store, published, moves }
}

describe('publishTemplateVersion — cổng trạng thái (tự-duyệt ĐƯỢC PHÉP)', () => {
  it('publishes a draft (approver ≠ author)', async () => {
    const { store, published } = fakeStore({ meta: { authoredBy: 'alice', status: 'draft' } })
    await publishTemplateVersion(store, 't1', 2, 'bob')
    expect(published[0]).toEqual({ t: 't1', v: 2, by: 'bob' })
  })
  // Cổng author≠approver ĐÃ GỠ khỏi kernel: governance là quyền `rules.manage`
  // ở app-layer, hãng nhỏ được tự-duyệt. Test giữ lại để KHOÁ hành vi đó, không phải để cấm nó.
  it('cho phép tự-duyệt (author === approver)', async () => {
    const { store, published } = fakeStore({ meta: { authoredBy: 'alice', status: 'draft' } })
    await publishTemplateVersion(store, 't1', 2, 'alice')
    expect(published[0]).toEqual({ t: 't1', v: 2, by: 'alice' })
  })
  it('rejects non-draft', async () => {
    const { store } = fakeStore({ meta: { authoredBy: 'alice', status: 'published' } })
    await expect(publishTemplateVersion(store, 't1', 2, 'bob')).rejects.toThrow(/draft/)
  })
  it('rejects unknown version', async () => {
    const { store } = fakeStore({ meta: null })
    await expect(publishTemplateVersion(store, 't1', 9, 'bob')).rejects.toThrow(/không tồn tại/)
  })
})

describe('moveChannel / rollbackChannel', () => {
  it('move records prevVersion = current pointer', async () => {
    const { store, moves } = fakeStore({ pointer: { version: 5, prevVersion: 4 } })
    await moveChannel(store, { templateId: 't1', channel: 'stable', version: 6, movedBy: 'bob' })
    expect(moves[0]).toMatchObject({ version: 6, prevVersion: 5 })
  })
  it('move from no pointer → prevVersion null', async () => {
    const { store, moves } = fakeStore({ pointer: null })
    await moveChannel(store, { templateId: 't1', channel: 'stable', version: 1, movedBy: 'bob' })
    expect(moves[0].prevVersion).toBeNull()
  })
  it('rollback moves back to prev_version', async () => {
    const { store, moves } = fakeStore({ pointer: { version: 6, prevVersion: 5 } })
    expect(await rollbackChannel(store, { templateId: 't1', channel: 'stable', movedBy: 'bob' })).toBe(5)
    expect(moves[0]).toMatchObject({ version: 5, prevVersion: 6, reason: 'rollback' })
  })
  it('rollback throws when no pointer / no prev', async () => {
    await expect(rollbackChannel(fakeStore({ pointer: null }).store, { templateId: 't1', channel: 'stable', movedBy: 'b' })).rejects.toThrow(/rollback/)
    await expect(rollbackChannel(fakeStore({ pointer: { version: 1, prevVersion: null } }).store, { templateId: 't1', channel: 'stable', movedBy: 'b' })).rejects.toThrow(/prev/)
  })
})
