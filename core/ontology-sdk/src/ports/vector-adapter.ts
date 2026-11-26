// The vector capability contract (source-spec §4, NT5, ADR-0006). Entirely
// separate from StorageAdapter — a tenant with no semantic-search need runs
// the structural ontology + rules with NO VectorAdapter at all.

import type { Row } from './storage-adapter.js'

export interface VectorItem {
  id: string
  text: string
  embedding: number[]
  meta: Row
}

export interface VectorHit {
  id: string
  score: number
  meta: Row
}

export interface VectorAdapter {
  upsert(items: VectorItem[]): Promise<void>
  search(embedding: number[], k: number, filter?: Row): Promise<VectorHit[]>
  withTenant(tenantId: string): VectorAdapter
}

/**
 * Optional embedding function the consumer injects at SDK construction (A-001).
 * When absent, context({ useVector: true }) returns documents: [] rather than
 * throwing (NT5 detachability).
 */
export type EmbedFn = (text: string) => Promise<number[]>
