// Provenance types live in @dqa-ai-solutions/ontology-base; the check stays here (base is declarations only).
import type { Provenance } from '@dqa-ai-solutions/ontology-base'
export type { Provenance, Ctx } from '@dqa-ai-solutions/ontology-base'

const isNonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0

/** True when all three provenance fields are present and non-empty. */
export function isCompleteProvenance(p: unknown): p is Provenance {
  if (p === null || typeof p !== 'object') return false
  const r = p as Record<string, unknown>
  return isNonEmpty(r.source_ref) && isNonEmpty(r.confirmed_by) && isNonEmpty(r.confirmed_at)
}
