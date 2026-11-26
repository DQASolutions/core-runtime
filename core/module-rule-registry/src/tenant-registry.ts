// Port decoupling rule-registry from WHERE the firm/client/period registry lives
// (design §9.5.1: registry → platform; §12.2 decision). The module references
// tenants by id and validates via this port instead of a hard FK, so it does not
// depend on the host app's tables being in the same DB.

export interface TenantRef {
  clientId: string
  firmId: string
  /** Thuộc tính khớp `applies_when` của template — khoá do APP định nghĩa và diễn giải.
   *  MÙ DOMAIN: registry không biết `profile` hay `business_type` là gì; nó chỉ so khoá↔khoá
   *  (xem `matchesTemplate`). Trước đây hai khoá đó có tên cứng ở đây — hai từ kế toán duy nhất
   *  còn sót trong package. Đổi thành map mở để domain khác dùng lại mà không phải fork. */
  attrs?: Record<string, string>
}

export interface TenantRegistry {
  /** Resolve a client to its firm + attributes. Throws/rejects if unknown. */
  getClient(clientId: string): Promise<TenantRef>
  /** as-of date for a run (= period end_date); drives effective-dating of rules. */
  asOfForClient(clientId: string): Promise<string>
}
