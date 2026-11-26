// ĐỐI CHIẾU TỔNG vs Σ CHI TIẾT — điều được gác là ba chỗ đã LÀM HỎNG SỐ THẬT một lần:
//
//  1. khai một chiều (`parts: closingDebit`) làm mọi chỉ tiêu dư CÓ bị báo lệch ĐÚNG BẰNG giá trị của nó
//     — đo trên khách thật: 8/16 chỉ tiêu BCĐKT, 176.984.660.075đ nêu thừa;
//  2. chỉ tiêu trình bày SỐ ÂM (hao mòn luỹ kế) cần đổi dấu, không thì lệch gấp đôi;
//  3. `when` mở ra khả năng một bản ghi trượt qua MỌI spec — trông y hệt "đã kiểm và đạt". Phải nêu.
import { describe, it, expect } from 'vitest'
import { reconcileMismatches, scoreOntologyData } from './validate-ontology.js'

const ont = (reconcile: any[]): any => ({ entities: [], relationships: [
  { name: 'item_account', from: 'Item', to: 'Account', kind: 'derivation', reconcile } ] })

const data = (wholes: any[], parts: any[]): any => ({
  instances: (t: string) => (t === 'Item' ? wholes : parts),
  neighbors: () => parts,
})

const BY_SIDE = [
  { whole: 'closingValue', sum: 'closingDebit', when: { side: 'debit' } },
  { whole: 'closingValue', sum: 'closingCredit', when: { side: 'credit' } },
  { whole: 'closingValue', sum: 'closingCredit', when: { side: 'credit_neg' }, sign: -1 },
]
const parts = [{ id: 'a', data: { closingDebit: 0, closingCredit: 300 } }]

describe('đối chiếu theo BÊN của bản ghi tổng', () => {
  it('chỉ tiêu dư CÓ đối chiếu với số dư Có — khai một chiều thì nó bị báo lệch đúng bằng giá trị', () => {
    const w = [{ id: 'i1', data: { side: 'credit', closingValue: 300 } }]
    expect(reconcileMismatches(ont(BY_SIDE), data(w, parts)).misses, 'đúng thì KHÔNG lệch').toHaveLength(0)

    const oneSided = [{ whole: 'closingValue', sum: 'closingDebit' }]
    const bad = reconcileMismatches(ont(oneSided), data(w, parts)).misses
    expect(bad, 'khai một chiều ⇒ nêu thừa').toHaveLength(1)
    expect(bad[0].diff, 'lệch đúng BẰNG giá trị chỉ tiêu — dấu hiệu nhận ra nêu thừa').toBe(300)
  })

  it('chỉ tiêu bên NỢ không bị spec bên Có chạm tới', () => {
    const w = [{ id: 'i2', data: { side: 'debit', closingValue: 0 } }]
    expect(reconcileMismatches(ont(BY_SIDE), data(w, parts)).misses).toHaveLength(0)
  })

  it('chỉ tiêu TRÌNH BÀY SỐ ÂM được đổi dấu', () => {
    const w = [{ id: 'i3', data: { side: 'credit_neg', closingValue: -300 } }]
    expect(reconcileMismatches(ont(BY_SIDE), data(w, parts)).misses, 'hao mòn luỹ kế: dư Có 300, trình bày −300').toHaveLength(0)
  })

  it('⚠ bản ghi KHÔNG spec nào áp phải được NÊU, không lặng lẽ bỏ qua', () => {
    const w = [{ id: 'i4', data: { closingValue: 999 } }]   // thiếu `side`
    const r = reconcileMismatches(ont(BY_SIDE), data(w, parts))
    expect(r.misses, 'chưa kiểm thì không kết luận lệch').toHaveLength(0)
    expect(r.skipped.map((s) => s.wholeId), 'nhưng phải nêu là CHƯA kiểm').toEqual(['i4'])
  })

  it('bản ghi chưa kiểm KHÔNG được tính là đạt trong điểm sức khoẻ', () => {
    const w = [{ id: 'i4', data: { closingValue: 999 } }]
    expect(scoreOntologyData(ont(BY_SIDE), data(w, parts))[0]).toMatchObject({ checked: 1, ok: 0 })
  })
})
