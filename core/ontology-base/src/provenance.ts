// Provenance — the mandatory audit triple attached to every write (NT3, ADR-0004).
// Shared kernel: used by Instance Graph and Rule & Evaluation contexts.

export interface Provenance {
  source_ref: string
  confirmed_by: string
  confirmed_at: string // ISO 8601
}

/** Ambient call context: which tenant, and who is acting (actor = provenance metadata). */
export interface Ctx {
  tenantId: string
  actor?: string
}
