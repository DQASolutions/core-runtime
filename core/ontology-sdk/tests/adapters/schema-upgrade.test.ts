/**
 * NÂNG BẢNG SIÊU DỮ LIỆU CỦA CHÍNH SDK — 5/9/2026.
 *
 * ⛔ VÌ SAO CÓ TỆP NÀY. `CREATE TABLE IF NOT EXISTS` chỉ đúng cho kho MỚI. Bảng
 *    đã có thì câu ấy là no-op, nên một cột thêm vào định nghĩa KHÔNG BAO GIỜ
 *    tới được kho đã dựng — rồi lượt `INSERT` kế tiếp đâm vào cột không tồn tại.
 *
 *    Đo được ở app tham chiếu: 5.9.0 thêm `property_defs.catalogue`; mọi kho
 *    dựng trước đó chết ở `applySchema`. Sáu nấc phát hành đều xanh, và chỉ máy
 *    nào đã có kho cũ mới hỏng — tức là mọi máy đang chạy thật.
 */
import { describe, it, expect } from 'vitest'
import { buildInitDDL } from '../../src/adapters/postgres/sql.js'
import { PROPERTY_TYPES } from '../../src/types/concepts.js'

const ddl = buildInitDDL('t_x').join('\n')

describe('buildInitDDL — bảng siêu dữ liệu nâng được, không chỉ dựng được', () => {
  it('thêm cột `catalogue` cho kho ĐÃ CÓ, không chỉ khai trong CREATE TABLE', () => {
    expect(ddl).toMatch(/ALTER TABLE "t_x"\.property_defs ADD COLUMN IF NOT EXISTS catalogue text/)
  })

  it('nêu lại CHECK của `type` ở mỗi lượt, và bỏ cả hai tên cũ để chạy lại được', () => {
    expect(ddl).toMatch(/DROP CONSTRAINT IF EXISTS property_defs_type_check/)
    expect(ddl).toMatch(/DROP CONSTRAINT IF EXISTS ck_property_defs_type/)
    expect(ddl).toMatch(/ADD CONSTRAINT ck_property_defs_type CHECK \(type IN \(/)
  })

  it('⛔ CHECK phải liệt kê ĐỦ mọi kiểu — kể cả kiểu vừa thêm', () => {
    const m = ddl.match(/ADD CONSTRAINT ck_property_defs_type CHECK \(type IN \(([^)]*)\)\)/)
    expect(m, 'không tìm thấy câu ADD CONSTRAINT').toBeTruthy()
    const listed = m![1]!.split(',').map((x) => x.trim().replace(/'/g, ''))
    expect(listed.sort()).toEqual([...PROPERTY_TYPES].sort())
  })

  it('⛔ KHÔNG CÒN DANH SÁCH KIỂU GÕ TAY trong DDL — một nguồn, không bản chép', () => {
    // Câu CREATE TABLE cũng phải sinh từ PROPERTY_TYPES; nếu ai gõ tay một danh
    // sách khác thì hai câu sẽ lệch nhau, và đó chính là cách `catalogue` lọt.
    const creates = ddl.match(/type\s+text\s+NOT NULL CHECK \(type IN \(([^)]*)\)\)/)
    expect(creates).toBeTruthy()
    const inCreate = creates![1]!.split(',').map((x) => x.trim().replace(/'/g, ''))
    expect(inCreate.sort()).toEqual([...PROPERTY_TYPES].sort())
  })

  it('mọi câu nâng đều chạy lại được nhiều lần (IF NOT EXISTS / IF EXISTS)', () => {
    const alters = buildInitDDL('t_x').filter((q) => /^ALTER TABLE/.test(q.trim()))
    for (const a of alters) {
      expect(a, a).toMatch(/IF NOT EXISTS|IF EXISTS|ADD CONSTRAINT/)
    }
  })
})
