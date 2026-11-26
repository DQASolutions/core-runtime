/**
 * `withTenant` PHẢI GIỮ LỚP CON — 5/9/2026.
 *
 * ⛔ VÌ SAO CÓ TỆP NÀY, ĐO ĐƯỢC. Một phép thử dựng lớp con của `InMemoryAdapter`
 *    để đếm giao dịch. `applyAction` gọi `withTenant`, bản gốc trả về
 *    `new InMemoryAdapter(...)` — lớp con biến mất — và phép thử đo một adapter
 *    KHÁC cái nó dựng. Bốn phép xanh sai trước khi ai hiểu ra.
 *
 *    `PostgresAdapter` có `spawn()` từ trước, và chú thích ở đó đã tả đúng lớp
 *    lỗi này: "silently degrading to a plain adapter mid-transaction, the kind
 *    of bug that only shows up on the write path under load". Bốn adapter còn
 *    lại không có. Bài học có rồi mà không ai áp sang hàng xóm.
 *
 * ⭐ CANH CẢ BỐN, KHÔNG CHỈ CÁI ĐÃ CẮN. Chốt chỉ soi một adapter thì adapter thứ
 *    năm dựng sau vẫn lọt y hệt.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { InMemoryAdapter } from '../../src/index.js'

describe('spawn — bản sao của adapter giữ đúng kiểu của nó', () => {
  /* ⚠️ HỢP ĐỒNG LÀ "MỘT CHỖ ĐỂ ĐÈ", KHÔNG PHẢI "TỰ GIỮ LỚP CON".
     Lượt viết đầu tôi kỳ vọng `new Con().withTenant()` trả về `Con` mà không đè
     gì — sai. `PostgresAdapter.spawn` cũng `new PostgresAdapter(...)`. Điều
     `spawn` cho là: lớp con chỉ phải đè MỘT hàm, thay vì đè `withTenant` và mọi
     hàm dựng-bản-sao khác rồi quên một cái. */
  it('lớp con đè `spawn` thì mọi bản sao là kiểu của nó', () => {
    class Counting extends InMemoryAdapter {
      spawned = 0
      readonly marker = 'con'
      protected override spawn(root: Parameters<InMemoryAdapter['withTenant']> extends never ? never : never, tenantId: string) {
        void root; void tenantId
        return this
      }
    }
    const a = new Counting()
    const view = a.withTenant('t1')
    expect(view).toBeInstanceOf(Counting)
    expect((view as Counting).marker).toBe('con')
  })

  it('không đè thì bản sao là lớp GỐC — nói ra để không ai tưởng nó tự giữ', () => {
    class Plain extends InMemoryAdapter {}
    const view = new Plain().withTenant('t1')
    expect(view).not.toBeInstanceOf(Plain)
    expect(view).toBeInstanceOf(InMemoryAdapter)
  })

  /* ⭐ ĐỌC MÃ NGUỒN, không chỉ chạy — hai adapter kia cần máy chủ thật (Neo4j,
     Qdrant) nên không dựng được ở đây. Chấm bằng hình dạng vẫn hơn không chấm. */
  const cases = [
    ['in-memory/in-memory-adapter.ts', 'InMemoryAdapter'],
    ['filesystem/filesystem-adapter.ts', 'FilesystemAdapter'],
    ['neo4j/neo4j-adapter.ts', 'Neo4jAdapter'],
    ['qdrant/qdrant-adapter.ts', 'QdrantVectorAdapter'],
    ['postgres/postgres-adapter.ts', 'PostgresAdapter'],
  ] as const

  for (const [file, cls] of cases) {
    it(`${cls}: có \`spawn\` và \`withTenant\` đi qua nó`, () => {
      const src = readFileSync(new URL(`../../src/adapters/${file}`, import.meta.url), 'utf8')
      expect(src, `${cls} thiếu spawn`).toMatch(/protected spawn\(/)
      // Cắt đúng thân `withTenant`: từ chữ `withTenant(` ở đầu một phương thức
      // (thụt hai dấu cách) tới dấu đóng ngoặc cùng mức thụt.
      const wt = src.match(/\n {2}withTenant\([^)]*\)[^{]*\{([\s\S]*?)\n {2}\}/)
      expect(wt, `${cls} không tìm thấy withTenant`).toBeTruthy()
      // ⛔ Thân `withTenant` phải gọi `this.spawn`, KHÔNG được `new <Lớp>` thẳng.
      expect(wt![1], `${cls}.withTenant còn dựng thẳng bằng new`).toMatch(/this\.spawn\(/)
      expect(wt![1], `${cls}.withTenant còn new lớp gốc`).not.toMatch(new RegExp(`new ${cls}\\(`))
    })
  }
})
