// Gợi-ý-subscribe (design §8): khi onboard / đổi business_type·profile, đề xuất
// template khớp `applies_when` để hãng DUYỆT (không auto-apply — human-in-loop).
// Pure: (templates, client attrs) → matching templates. App fetch dữ liệu + hiện UI.

/** A template's applicability criteria (từ rule_template). */
export interface TemplateCriteria {
  templateId: string
  key: string
  /** jsonb applies_when: {business_type:[...], profile:[...]}. null/empty = áp cho MỌI client. */
  appliesWhen?: Record<string, string[]> | null
  layerRank: number
}

/** Thuộc tính client dùng để khớp (khoá trùng khoá trong applies_when: business_type, profile...). */
export type ClientAttrs = Record<string, string | null | undefined>

/** Template khớp khi MỌI khoá ràng buộc trong applies_when đều thoả (AND). Khoá không
 *  ràng buộc (mảng rỗng) bị bỏ qua; applies_when null/rỗng → khớp tất cả (base). */
export function matchesTemplate(appliesWhen: TemplateCriteria['appliesWhen'], attrs: ClientAttrs): boolean {
  if (!appliesWhen) return true
  for (const [key, allowed] of Object.entries(appliesWhen)) {
    if (!Array.isArray(allowed) || allowed.length === 0) continue // không ràng buộc khoá này
    const v = attrs[key]
    if (v == null || !allowed.includes(v)) return false
  }
  return true
}

/** Các template hãng mà client đủ điều kiện, sắp theo layer_rank (base → segment → topic). */
export function suggestTemplates(templates: TemplateCriteria[], attrs: ClientAttrs): TemplateCriteria[] {
  return templates
    .filter((t) => matchesTemplate(t.appliesWhen, attrs))
    .sort((a, b) => a.layerRank - b.layerRank || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}
