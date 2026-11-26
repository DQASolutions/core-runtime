// Semantic Retrieval context (Layer 2) — NT5, ADR-0006. Returns BOTH the
// structural neighbourhood (instances + edges + related rules) AND optional
// vector documents. The vector half is detachable: with no VectorAdapter or no
// embed function configured, `documents` is [] — never an error.

import {
  type Chunk,
  type ContextBundle,
  type Edge,
  type Instance,
  type RuleDef,
  ontologyError,
} from '../../types/index.js'
import type { StorageAdapter } from '../../ports/storage-adapter.js'
import type { EmbedFn, VectorAdapter } from '../../ports/vector-adapter.js'

export interface ContextOpts {
  query: string
  around?: string
  useVector?: boolean
  k?: number
}

// @impl BR-014, S009-AC-001, S009-AC-002, S009-AC-005, S009-AC-006, S009-AC-007, S009-AC-009, S009-AC-010, S009-AC-011
export async function retrieveContext(
  opts: ContextOpts,
  adapter: StorageAdapter,
  vector?: VectorAdapter,
  embed?: EmbedFn,
): Promise<ContextBundle> {
  const structured = { instances: [] as Instance[], edges: [] as Edge[], rules: [] as RuleDef[] }

  if (opts.around) {
    const center = await adapter.getInstance(opts.around)
    // FR-E01: around must reference an existing instance
    if (!center) throw ontologyError('INSTANCE_NOT_FOUND', `Instance "${opts.around}" not found`)
    structured.instances.push(center)
    const out = await adapter.queryEdges({ fromId: center.id })
    const incoming = await adapter.queryEdges({ toId: center.id })
    const edges = [...out, ...incoming]
    structured.edges.push(...edges)
    const neighborIds = new Set<string>()
    for (const e of edges) {
      neighborIds.add(e.fromId === center.id ? e.toId : e.fromId)
    }
    for (const id of neighborIds) {
      const n = await adapter.getInstance(id)
      if (n) structured.instances.push(n)
    }
    structured.rules.push(...(await adapter.queryRules({ appliesTo: center.entityType })))
  }

  let documents: Chunk[] = []
  if (opts.useVector && vector && embed) {
    try {
      // FR-N08: default k = 10
      const embedding = await embed(opts.query)
      const hits = await vector.search(embedding, opts.k ?? 10)
      documents = hits.map((h) => ({
        id: h.id,
        text: typeof h.meta.text === 'string' ? h.meta.text : '',
        score: h.score,
        meta: h.meta,
      }))
    } catch {
      // FR-E05: vector search failures are non-fatal; documents degrades to []
      documents = []
    }
  }
  // useVector requested but no embed/vector configured → [] (A-001/A-012), no throw.

  return { structured, documents }
}
