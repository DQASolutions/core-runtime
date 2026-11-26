import { describe, it, expect } from 'vitest'
import type { Instance, FunctionIO } from '@dqa-ai-solutions/ontology-model'
import { evalBool, evalExpr, ruleFromIR, EvalError, type ExprNode } from './eval-expr.js'

const node = (id: string, data: Record<string, unknown> = {}): Instance =>
  ({ id, entityType: 'X', data, provenance: { source_ref: '', confirmed_by: '', confirmed_at: '' }, source_ref: '', confirmed_by: '', confirmed_at: '' })

// in-memory io: edges keyed by `${fromId}|${rel}` → neighbour nodes
function ioOver(nodes: Instance[], edges: Record<string, Instance[]>): FunctionIO {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  return {
    get: async (id) => byId.get(id) ?? null,
    find: async (t) => nodes.filter((n) => n.entityType === t),
    neighbors: async (id, rel) => edges[`${id}|${rel}`] ?? [],
  } as FunctionIO
}

const io0 = ioOver([], {})
const ev = (expr: ExprNode, self: Instance, io: FunctionIO = io0) => evalBool(expr, { self, io })

describe('eval-expr — leaves, arithmetic, compare, logic', () => {
  const n = node('a', { x: 10, y: 3, name: 'cash' })

  it('prop reads self; arithmetic composes', async () => {
    const expr: ExprNode = { op: 'compare', cmp: '=', left: { op: 'add', left: { op: 'prop', field: 'x' }, right: { op: 'prop', field: 'y' } }, right: { op: 'lit', value: 13 } }
    expect(await ev(expr, n)).toBe(true)
  })

  it('compare honours tolerance', async () => {
    const within: ExprNode = { op: 'compare', cmp: '=', tolerance: 1, left: { op: 'prop', field: 'x' }, right: { op: 'lit', value: 10.5 } }
    expect(await ev(within, n)).toBe(true)
    const ne: ExprNode = { op: 'compare', cmp: '!=', tolerance: 1, left: { op: 'prop', field: 'x' }, right: { op: 'lit', value: 12 } }
    expect(await ev(ne, n)).toBe(true)
  })

  it('text equality + and/or/not + if', async () => {
    const expr: ExprNode = {
      op: 'and',
      children: [
        { op: 'compare', cmp: '=', left: { op: 'prop', field: 'name' }, right: { op: 'lit', value: 'cash' } },
        { op: 'not', child: { op: 'compare', cmp: '>', left: { op: 'prop', field: 'y' }, right: { op: 'prop', field: 'x' } } },
      ],
    }
    expect(await ev(expr, n)).toBe(true)
    const branch: ExprNode = { op: 'if', cond: { op: 'lit', value: false }, then: { op: 'lit', value: true }, else: { op: 'lit', value: false } }
    expect(await ev(branch, n)).toBe(false)
  })

  it('startsWith / daysBetween / div-by-zero guard', async () => {
    expect(await ev({ op: 'startsWith', text: { op: 'lit', value: '5111' }, prefix: { op: 'lit', value: '511' } }, n)).toBe(true)
    const days: ExprNode = { op: 'compare', cmp: '=', left: { op: 'daysBetween', from: { op: 'lit', value: '2026-01-01' }, to: { op: 'lit', value: '2026-01-31' } }, right: { op: 'lit', value: 30 } }
    expect(await ev(days, n)).toBe(true)
    await expect(evalExpr({ op: 'div', left: { op: 'lit', value: 1 }, right: { op: 'lit', value: 0 } }, { self: n, io: io0 })).rejects.toBeInstanceOf(EvalError)
  })
})

describe('eval-expr — set algebra with per-element `it` binding', () => {
  // a balance with 3 subledger entries (the filter+sum showcase)
  const bal = node('bal', { closingDebit: 40, closingCredit: 0 })
  const e1 = node('e1', { side: 'debit', closingBalance: 10 })
  const e2 = node('e2', { side: 'credit', closingBalance: 20 })
  const e3 = node('e3', { side: '', closingBalance: 30 }) // '' counts as debit side
  const io = ioOver([bal, e1, e2, e3], { 'bal|sub': [e1, e2, e3] })

  const debitSide: ExprNode = {
    op: 'sum',
    set: {
      op: 'filter',
      set: { op: 'rel', rel: 'sub' },
      where: { op: 'or', children: [
        { op: 'compare', cmp: '=', left: { op: 'prop', field: 'side' }, right: { op: 'lit', value: '' } },
        { op: 'compare', cmp: '=', left: { op: 'prop', field: 'side' }, right: { op: 'lit', value: 'debit' } },
      ] },
    },
    value: { op: 'prop', field: 'closingBalance' },
  }

  it('Σ over a FILTERED neighbour set — prop inside reads the element (it), not self', async () => {
    // debit-side entries = e1(10) + e3(30) = 40
    const expr: ExprNode = { op: 'compare', cmp: '=', left: debitSide, right: { op: 'prop', field: 'closingDebit' } }
    expect(await evalBool(expr, { self: bal, io })).toBe(true)
  })

  it('count / any / exists over neighbours', async () => {
    expect(await evalExpr({ op: 'count', set: { op: 'rel', rel: 'sub' } }, { self: bal, io })).toBe(3)
    const anyCredit: ExprNode = { op: 'any', set: { op: 'rel', rel: 'sub' }, where: { op: 'compare', cmp: '=', left: { op: 'prop', field: 'side' }, right: { op: 'lit', value: 'credit' } } }
    expect(await evalBool(anyCredit, { self: bal, io })).toBe(true)
    expect(await evalBool({ op: 'exists', set: { op: 'rel', rel: 'sub' } }, { self: bal, io })).toBe(true)
  })

  it('sugar ops desugar to rel+γ', async () => {
    expect(await evalExpr({ op: 'sumNeighbors', rel: 'sub', field: 'closingBalance' }, { self: bal, io })).toBe(60)
    expect(await evalExpr({ op: 'countNeighbors', rel: 'sub' }, { self: bal, io })).toBe(3)
    expect(await evalBool({ op: 'hasNeighbors', rel: 'sub' }, { self: bal, io })).toBe(true)
  })
})

describe('eval-expr — rule-as-DATA matches the hand-written TypeScript rule', () => {
  // Encode R-ROLLFORWARD as IR and check parity with the TS predicate's logic.
  const credit = (f: string): ExprNode => ({ op: 'compare', cmp: '=', left: { op: 'prop', field: 'normalBalance' }, right: { op: 'lit', value: 'credit' } })
  const sub3 = (a: string, b: string, c: string): ExprNode => ({ op: 'sub', left: { op: 'add', left: { op: 'prop', field: a }, right: { op: 'prop', field: b } }, right: { op: 'prop', field: c } })
  const rollforwardIR: ExprNode = {
    op: 'if',
    cond: { op: 'compare', cmp: '=', left: { op: 'prop', field: 'normalBalance' }, right: { op: 'lit', value: 'dual' } },
    then: { op: 'lit', value: false }, // dual: handled per cluster ⇒ never fires here
    else: {
      op: 'compare', cmp: '!=', tolerance: 1,
      left: { op: 'if', cond: credit(''), then: { op: 'prop', field: 'closingCredit' }, else: { op: 'prop', field: 'closingDebit' } },
      right: { op: 'if', cond: credit(''), then: sub3('openingCredit', 'periodCredit', 'periodDebit'), else: sub3('openingDebit', 'periodDebit', 'periodCredit') },
    },
  }
  const r = ruleFromIR({ on: 'AccountBalance', id: 'R-ROLLFORWARD', severity: 'critical', expr: rollforwardIR })

  // reference TS logic (the existing common.ts rule)
  const whenHolds = (d: Record<string, number | string>): boolean => {
    if (d.normalBalance === 'dual') return false
    const cr = d.normalBalance === 'credit'
    const expected = cr ? Number(d.openingCredit) + Number(d.periodCredit) - Number(d.periodDebit) : Number(d.openingDebit) + Number(d.periodDebit) - Number(d.periodCredit)
    const closing = cr ? Number(d.closingCredit) : Number(d.closingDebit)
    return Math.abs(closing - expected) > 1
  }

  const cases = [
    { normalBalance: 'debit',  openingDebit: 100, periodDebit: 50, periodCredit: 20, closingDebit: 130, closingCredit: 0, openingCredit: 0 }, // balanced → no fire
    { normalBalance: 'debit',  openingDebit: 100, periodDebit: 50, periodCredit: 20, closingDebit: 999, closingCredit: 0, openingCredit: 0 }, // off → fire
    { normalBalance: 'credit', openingCredit: 200, periodCredit: 80, periodDebit: 30, closingCredit: 250, closingDebit: 0, openingDebit: 0 }, // balanced → no fire
    { normalBalance: 'dual',   openingDebit: 5, periodDebit: 5, periodCredit: 0, closingDebit: 999, closingCredit: 0, openingCredit: 0 },     // dual → never fires
  ]

  it('IR verdict equals TS verdict on every case', async () => {
    for (const c of cases) {
      const irVerdict = Boolean(await r.khi!(node('b', c), io0))
      expect(irVerdict).toBe(whenHolds(c as Record<string, number | string>))
    }
  })
})

// textContains / left — hai op VĂN BẢN bổ sung cho startsWith. Lý do tồn tại: không có chúng thì mọi luật
// "mô tả có nhắc tới X" và mọi phép so hai mã Ở CÙNG ĐỘ SÂU phải viết bằng mã tay, đúng thứ IR sinh ra để thay.
describe('text ops', () => {
  const P = (f: string): ExprNode => ({ op: 'prop', node: { op: 'self' }, field: f })
  const L = (v: unknown): ExprNode => ({ op: 'lit', value: v as never })

  it('textContains khớp CHUỖI CON, không phân biệt hoa/thường, khác hẳn contains (thành viên mảng)', async () => {
    const e: ExprNode = { op: 'textContains', text: P('description'), value: L('thay đổi') }
    expect(await ev(e, node('a', { description: 'Có THAY ĐỔI đăng ký HĐĐT' }))).toBe(true)
    expect(await ev(e, node('b', { description: 'đăng ký lần đầu' }))).toBe(false)
    // thiếu trường ⇒ false, không ném — luật không được chết vì dữ liệu khách rỗng
    expect(await ev(e, node('c', {}))).toBe(false)
  })

  it('left cho phép so hai mã Ở CÙNG ĐỘ SÂU — điều startsWith KHÔNG làm được', async () => {
    const grp = (f: string): ExprNode => ({ op: 'left', text: P(f), n: L(3) })
    const same: ExprNode = { op: 'compare', cmp: '=', left: grp('a'), right: grp('b') }
    // 1121 vs 1122: cùng nhóm 112 nhưng KHÔNG cái nào là tiền tố của cái kia
    expect(await ev(same, node('x', { a: '1121', b: '1122' }))).toBe(true)
    expect(await ev({ op: 'startsWith', text: P('a'), prefix: P('b') }, node('x', { a: '1121', b: '1122' }))).toBe(false)
    expect(await ev(same, node('y', { a: '1121', b: '3311' }))).toBe(false)
  })

  it('left với n ≤ 0 ⇒ chuỗi rỗng (toàn phần, không ném)', async () => {
    expect(await evalExpr({ op: 'left', text: L('1121'), n: L(0) }, { self: node('z'), io: io0 })).toBe('')
  })
})

// num / text / size — ÉP KIỂU TOÀN PHẦN. Không thêm sức biểu đạt, thêm TÍNH TOÀN PHẦN: dữ liệu khách
// thưa, trường vắng là bình thường. Không có chúng thì `x > 0` trên trường vắng NÉM → luật bị loại khỏi
// kỳ → phép kiểm im lặng; và `prop != ''` trên trường vắng trả TRUE → luật bắn vào mọi bản ghi.
describe('total coercion ops', () => {
  const P = (f: string): ExprNode => ({ op: 'prop', node: { op: 'self' }, field: f })
  const L = (v: unknown): ExprNode => ({ op: 'lit', value: v as never })
  const N = (f: string): ExprNode => ({ op: 'num', arg: P(f) })
  const T = (f: string): ExprNode => ({ op: 'text', arg: P(f) })

  it('num làm phép so số KHÔNG ném khi trường vắng', async () => {
    const e: ExprNode = { op: 'compare', cmp: '>', left: N('amount'), right: L(0) }
    await expect(ev({ op: 'compare', cmp: '>', left: P('amount'), right: L(0) }, node('a', {}))).rejects.toThrow()
    expect(await ev(e, node('a', {}))).toBe(false)
    expect(await ev(e, node('b', { amount: 5 }))).toBe(true)
    expect(await ev(e, node('c', { amount: '1,500' }))).toBe(true)   // số có dấu phân cách vẫn đọc được
  })

  it("text sửa bẫy `prop != ''` — trường VẮNG phải là RỖNG, không phải KHÁC RỖNG", async () => {
    const bare: ExprNode = { op: 'compare', cmp: '!=', left: P('correctionType'), right: L('') }
    const safe: ExprNode = { op: 'compare', cmp: '!=', left: T('correctionType'), right: L('') }
    expect(await ev(bare, node('a', {}))).toBe(true)    // bẫy: bắn vào mọi bản ghi không có trường
    expect(await ev(safe, node('a', {}))).toBe(false)
    expect(await ev(safe, node('b', { correctionType: 'replace' }))).toBe(true)
  })

  it('size đếm được mảng vắng mà empty() thì ném', async () => {
    const e: ExprNode = { op: 'compare', cmp: '=', left: { op: 'size', arg: P('roles') }, right: L(0) }
    await expect(ev({ op: 'empty', set: P('roles') }, node('a', {}))).rejects.toThrow()
    expect(await ev(e, node('a', {}))).toBe(true)
    expect(await ev(e, node('b', { roles: [] }))).toBe(true)
    expect(await ev(e, node('c', { roles: ['cash'] }))).toBe(false)
  })
})

// finding.values + join — CÂU FINDINGS NÓI ĐƯỢC SỐ NÓ VỪA TÍNH.
// `delta` xưa nay tính được, nhưng `message` chỉ đọc thuộc tính của node neo. Luật đứng trên một node
// không mang số (kỳ kế toán, doanh nghiệp) vì thế có thể phát hiện lệch 1,9 tỷ mà không nói nổi con số.
// Luật nổ mà không nói được nó thấy gì thì người đọc không hành động được — tệ hơn luật không chạy.
describe('finding.values', () => {
  const P = (f: string): ExprNode => ({ op: 'prop', node: { op: 'self' }, field: f })
  const L = (v: unknown): ExprNode => ({ op: 'lit', value: v as never })
  const IT = (f: string): ExprNode => ({ op: 'prop', node: { op: 'it' }, field: f })
  const period = node('p', { code: '2026Q1' })

  it('chèn được SỐ TÍNH RA, có định dạng nghìn', async () => {
    const r = ruleFromIR({
      id: 'R-X', on: 'X', severity: 'warning', expr: L(true),
      finding: {
        values: { thieu: { op: 'sub', left: L(2_000_000_000), right: L(94_524_944) } },
        message: 'Kỳ {code} còn THIẾU {thieu|vnd}đ.',
      },
    })
    const v = await r.khi!(period, io0)
    expect((v as { message: string }).message).toBe('Kỳ 2026Q1 còn THIẾU 1.905.475.056đ.')
  })

  it('join gộp tập thành CHỮ — thứ `sum`/`count` không làm được', async () => {
    const rows = [node('a', { month: 5 }), node('b', { month: 1 }), node('c', { month: 2 }), node('d', { month: 1 })]
    const io = ioOver(rows.map((n) => ({ ...n, entityType: 'Payroll' })), {})
    const r = ruleFromIR({
      id: 'R-Y', on: 'X', severity: 'info', expr: L(true),
      finding: {
        values: { thang: { op: 'join', set: { op: 'find', entityType: 'Payroll' }, value: IT('month'), sep: ',' } },
        message: 'Tháng {thang} chưa nạp bảng lương.',
      },
    })
    // khử trùng + sắp theo SỐ: cùng một tập phải luôn ra cùng một câu, bất kể thứ tự đọc từ kho
    expect(((await r.khi!(period, io)) as { message: string }).message).toBe('Tháng 1,2,5 chưa nạp bảng lương.')
  })

  // Hai vết của CHÍNH phép thay thế, không phải của luật: số lẻ dấu phẩy động, và trường rỗng để lại
  // ngoặc/khoảng trắng treo. Người soạn luật không nên phải phòng cho từng trường có thể rỗng.
  it('dọn vết thay thế: số lẻ cắt gọn, trường rỗng không để lại ngoặc/khoảng trắng treo', async () => {
    const mv = node('m', { itemCode: 'VAT TU A-01', itemName: '', quantity: 0.5042099999999999, uom: '', qty2: 12 })
    const r = ruleFromIR({
      id: 'R-Q', on: 'X', severity: 'warning', expr: L(true),
      finding: { message: 'Mã «{itemCode}» ({itemName}) số lượng {quantity} {uom} — trên {qty2} phiếu.' },
    })
    expect(((await r.khi!(mv, io0)) as { message: string }).message)
      .toBe('Mã «VAT TU A-01» số lượng 0.5042 — trên 12 phiếu.')   // số nguyên giữ nguyên: 12, không «12,0»
  })

  // Bản dọn đầu tiên quét cả câu và bóp mất đôi dấu cách TRONG DỮ LIỆU. Tên người là thứ mang đi đối chiếu
  // với danh sách cơ quan — sửa nó là làm hỏng bằng chứng, dù nhìn thì «đẹp hơn».
  it('KHÔNG đụng vào khoảng trắng nằm trong GIÁ TRỊ lấy từ hồ sơ', async () => {
    const emp = node('e', { hoTen: 'NGUYEN  VAN A', ghiChu: '' })
    const r = ruleFromIR({ id: 'R-W', on: 'X', severity: 'warning', expr: L(true), finding: { message: '«{hoTen}» {ghiChu}: rà lại.' } })
    expect(((await r.khi!(emp, io0)) as { message: string }).message).toBe('«NGUYEN  VAN A»: rà lại.')
  })

  it('mệnh đề CÓ ĐIỀU KIỆN không cần cơ chế mới — `if` trả về đoạn chữ', async () => {
    const clause = (n: number): ExprNode =>
      ({ op: 'if', cond: { op: 'compare', cmp: '>', left: L(n), right: L(0) }, then: L(' (còn áp giảm trừ — SAI)'), else: L('') })
    const mk = (n: number) => ruleFromIR({
      id: 'R-Z', on: 'X', severity: 'info', expr: L(true),
      finding: { values: { ghiChu: clause(n) }, message: 'Kỳ {code}{ghiChu}.' },
    })
    expect(((await mk(5).khi!(period, io0)) as { message: string }).message).toBe('Kỳ 2026Q1 (còn áp giảm trừ — SAI).')
    expect(((await mk(0).khi!(period, io0)) as { message: string }).message).toBe('Kỳ 2026Q1.')
  })

  it('values THẮNG thuộc tính node khi trùng tên (ghi đè là cố ý)', async () => {
    const r = ruleFromIR({
      id: 'R-W', on: 'X', severity: 'info', expr: L(true),
      finding: { values: { code: L('ĐÃ-ĐỔI') }, message: '{code}' },
    })
    expect(((await r.khi!(period, io0)) as { message: string }).message).toBe('ĐÃ-ĐỔI')
  })

  it('KHÔNG khai values ⇒ hành vi y hệt trước (175 luật đang chạy không được đổi một byte)', async () => {
    const r = ruleFromIR({ id: 'R-V', on: 'X', severity: 'info', expr: L(true), finding: { message: 'Kỳ {code}, thiếu {khong_co}.' } })
    // Trường không có vẫn thay bằng RỖNG (không ném, không bỏ nguyên `{khong_co}`) — bất biến này giữ nguyên.
    // Khác một chỗ so với trước: khoảng trắng treo trước dấu chấm bị dọn. Đó là vết của phép thay thế,
    // không phải chữ của người soạn luật; giữ lại chỉ để câu in ra sai chính tả.
    expect(((await r.khi!(period, io0)) as { message: string }).message).toBe('Kỳ 2026Q1, thiếu.')
  })

  it('values KHÔNG được tính khi luật không nổ (quét cả một loại là đắt)', async () => {
    let touched = 0
    const io = { get: async () => null, neighbors: async () => [], find: async () => { touched++; return [] } } as never
    const r = ruleFromIR({
      id: 'R-U', on: 'X', severity: 'info', expr: L(false),
      finding: { values: { x: { op: 'count', set: { op: 'find', entityType: 'Payroll' } } }, message: '{x}' },
    })
    expect(await r.khi!(period, io)).toBe(false)
    expect(touched).toBe(0)
  })
})

// `as` + `var` — ĐẶT TÊN PHẦN TỬ VÒNG LẶP.
// `it` chỉ là MỘT ô nên vòng trong che vòng ngoài. Khuôn phổ biến nhất của phép cộng cấp kỳ —
// "cộng CHỈ tài khoản LÁ" (với mỗi tài khoản, hỏi có tài khoản nào KHÁC lấy nó làm tiền tố không) —
// vì thế không khai báo được, và mọi luật loại đó buộc phải viết bằng mã tay.
describe('biến vòng lặp đặt tên', () => {
  const L = (v: unknown): ExprNode => ({ op: 'lit', value: v as never })
  const VAR = (n: string, f: string): ExprNode => ({ op: 'prop', node: { op: 'var', name: n }, field: f })
  const IT = (f: string): ExprNode => ({ op: 'prop', node: { op: 'it' }, field: f })
  const acc = (code: string, amount: number) => ({ ...node(code, { accountCode: code, periodCredit: amount }), entityType: 'AccountBalance' })
  const rows = [acc('511', 0), acc('5111', 100), acc('5112', 250), acc('632', 70)]
  const io = ioOver(rows, {})

  // Σ CHỈ TK LÁ: 5111 + 5112 = 350. Có TK cha 511 (số 0) nên phép cộng thô vẫn ra 350 — dùng số khác 0
  // ở TK cha để ca này thật sự phân biệt được đúng/sai.
  const rowsWithParentAmount = [acc('511', 999), acc('5111', 100), acc('5112', 250)]

  const isLeaf: ExprNode = {
    op: 'not',
    child: { op: 'any', set: { op: 'find', entityType: 'AccountBalance' },
      where: { op: 'and', children: [
        { op: 'compare', cmp: '!=', left: IT('accountCode'), right: VAR('a', 'accountCode') },
        { op: 'startsWith', text: IT('accountCode'), prefix: VAR('a', 'accountCode') },
      ] } },
  }
  const sumLeaf: ExprNode = {
    op: 'sum', as: 'a', set: { op: 'find', entityType: 'AccountBalance' },
    value: { op: 'if', cond: isLeaf, then: { op: 'num', arg: IT('periodCredit') }, else: L(0) },
  }

  it('cộng CHỈ tài khoản lá — bỏ tài khoản cha, không đếm đôi', async () => {
    const ctx = { self: node('p'), io: ioOver(rowsWithParentAmount, {}) }
    expect(await evalExpr(sumLeaf, ctx)).toBe(350)
  })

  it('không có `as` thì vòng trong CHE vòng ngoài — đây chính là chỗ bí trước đây', async () => {
    const noAs = JSON.parse(JSON.stringify(sumLeaf)); delete noAs.as
    // `var` không được ràng buộc ⇒ NÉM rõ ràng, không âm thầm cho ra số sai
    await expect(evalExpr(noAs, { self: node('p'), io })).rejects.toThrow(/chưa được ràng buộc/)
  })

  it('`it` vẫn chạy y nguyên khi không khai `as` (luật cũ không đổi)', async () => {
    const plain: ExprNode = { op: 'sum', set: { op: 'find', entityType: 'AccountBalance' }, value: { op: 'num', arg: IT('periodCredit') } }
    expect(await evalExpr(plain, { self: node('p'), io })).toBe(420)
  })
})

describe('concat', () => {
  const L = (v: unknown): ExprNode => ({ op: 'lit', value: v as never })
  const IT = (f: string): ExprNode => ({ op: 'prop', node: { op: 'it' }, field: f })

  it('nối được nhãn có TRANG TRÍ, không chỉ trơ một cột', async () => {
    const rows = [{ ...node('x', { accountCode: '2118', referencedBy: 'sổ TSCĐ' }), entityType: 'A' },
                  { ...node('y', { accountCode: '6422', referencedBy: 'sổ CCDC' }), entityType: 'A' }]
    const e: ExprNode = { op: 'join', set: { op: 'find', entityType: 'A' }, sep: ' · ',
      value: { op: 'concat', parts: [L('TK '), IT('accountCode'), L(' ('), IT('referencedBy'), L(')')] } }
    expect(await evalExpr(e, { self: node('p'), io: ioOver(rows, {}) }))
      .toBe('TK 2118 (sổ TSCĐ) · TK 6422 (sổ CCDC)')
  })

  it('phần vắng thành rỗng, không thành "undefined" lọt ra bản soát xét', async () => {
    const e: ExprNode = { op: 'concat', parts: [L('TK '), { op: 'prop', node: { op: 'self' }, field: 'khong_co' }, L('.')] }
    expect(await evalExpr(e, { self: node('p', {}), io: io0 })).toBe('TK .')
  })
})

it('money định dạng theo lối Việt Nam ngay TRONG câu ghép', async () => {
  const e: ExprNode = { op: 'concat', parts: [
    { op: 'lit', value: 'mượn ' }, { op: 'money', arg: { op: 'lit', value: 12821910284 } }, { op: 'lit', value: 'đ' }] }
  expect(await evalExpr(e, { self: node('x'), io: io0 })).toBe('mượn 12.821.910.284đ')
})

it('finding.severity đổi mức theo TỪNG CA, đè mức tĩnh của luật', async () => {
  const L = (v: unknown): ExprNode => ({ op: 'lit', value: v as never })
  const P = (f: string): ExprNode => ({ op: 'prop', node: { op: 'self' }, field: f })
  const r = ruleFromIR({
    id: 'R-CAP', on: 'X', severity: 'info', expr: L(true),
    finding: {
      severity: { op: 'if', cond: { op: 'compare', cmp: '>', left: { op: 'num', arg: P('lai') }, right: { op: 'num', arg: P('tran') } },
                  then: L('warning'), else: L('info') },
      message: 'x',
    },
  })
  expect(((await r.khi!(node('a', { lai: 100, tran: 30 }), io0)) as { severity: string }).severity).toBe('warning')
  expect(((await r.khi!(node('b', { lai: 10, tran: 30 }), io0)) as { severity: string }).severity).toBe('info')
})

// `incoming` — đi cạnh NGƯỢC CHIỀU.
// Cạnh khai một chiều (`SourceDocument → JournalEntry`) nhưng câu hỏi soát xét thường đứng ở ĐẦU KIA:
// "bút toán này có chứng từ nào trỏ tới không". Thiếu phép này thì cả họ luật truy-vết phải viết tay.
describe('incoming', () => {
  const je = (id: string) => ({ ...node(id, { docNumber: id }), entityType: 'JournalEntry' })
  const nodes = [je('j1'), je('j2')]
  const io = {
    get: async () => null,
    find: async (t: string) => (t === 'JournalEntry' ? nodes : []),
    neighbors: async () => [],
    // host cấp bảng NGƯỢC: đích → các nguồn trỏ tới nó
    incoming: async (id: string, rel: string) =>
      rel === 'sourceDocument_journalEntry' && id === 'j1' ? [node('d1', { docNumber: 'HD01' })] : [],
  } as never

  const hasDoc: ExprNode = { op: 'exists', set: { op: 'incoming', rel: 'sourceDocument_journalEntry', node: { op: 'it' } } }

  it('đếm được bút toán KHÔNG có chứng từ nào trỏ tới', async () => {
    const e: ExprNode = { op: 'count', set: { op: 'find', entityType: 'JournalEntry' }, where: { op: 'not', child: hasDoc } }
    expect(await evalExpr(e, { self: node('p'), io })).toBe(1)   // j2 đứt, j1 có chứng từ
  })

  it('ném RÕ RÀNG khi host chưa cấp bảng ngược — không âm thầm trả rỗng', async () => {
    const bare = { get: async () => null, find: async () => [], neighbors: async () => [] } as never
    await expect(evalExpr({ op: 'exists', set: { op: 'incoming', rel: 'x', node: { op: 'self' } } }, { self: node('a'), io: bare }))
      .rejects.toThrow(/chưa nối/)
  })
})
