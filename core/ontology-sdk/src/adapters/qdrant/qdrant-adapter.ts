// Layer 1 — QdrantVectorAdapter. ONLY layer allowed to import @qdrant/js-client-rest.
// Collection-per-tenant model; lazy collection creation on first upsert (NT5 graceful
// degradation — search on a missing collection returns [] rather than throwing).

import type { QdrantClient, Schemas } from '@qdrant/js-client-rest'
import type { Row } from '../../ports/storage-adapter.js'
import type { VectorAdapter, VectorHit, VectorItem } from '../../ports/vector-adapter.js'
import { loadDriver } from '../load-driver.js'

export interface QdrantAdapterOptions {
  url?: string
  client?: QdrantClient
  collectionPrefix?: string
}

// Qdrant Filter is a recursive schema type — alias it for clarity.
type QdrantFilter = Schemas['Filter']
type QdrantCondition = Schemas['Condition']

export class QdrantVectorAdapter implements VectorAdapter {
  private readonly client: QdrantClient
  private readonly collection: string
  // Cache the set of collections we know exist so we only attempt create-if-absent once.
  private readonly knownCollections: Set<string>

  constructor(opts?: QdrantAdapterOptions, collection?: string, knownCollections?: Set<string>) {
    const url = opts?.url ?? process.env['QDRANT_URL'] ?? 'http://localhost:6333'
    this.client = opts?.client ?? new (loadDriver<typeof import('@qdrant/js-client-rest')>('@qdrant/js-client-rest', 'QdrantVectorAdapter').QdrantClient)({ url })
    const prefix = opts?.collectionPrefix ?? 'ont'
    this.collection = collection ?? `${prefix}___default__`
    this.knownCollections = knownCollections ?? new Set<string>()
  }

  // ── VectorAdapter.withTenant ──────────────────────────────────────────────

  /**
   * ⭐ CHỖ DUY NHẤT dựng một bản sao — xem chú thích cùng tên ở
   *    `PostgresAdapter.spawn`. Thêm 5/9/2026 cho cả bốn adapter còn thiếu.
   */
  protected spawn(collection: string, knownCollections: Set<string>): VectorAdapter {
    return new QdrantVectorAdapter({ client: this.client }, collection, knownCollections)
  }

  withTenant(tenantId: string): VectorAdapter {
    const prefix = this.collection.replace(/___default__$/, '').replace(/_[^_]*$/, '') || 'ont'
    const safeTenantId = tenantId.replace(/[^a-zA-Z0-9_]/g, '_')
    const tenantCollection = `${prefix}_${safeTenantId}`
    // Share both the client instance and the knownCollections cache across views.
    return this.spawn(tenantCollection, this.knownCollections)
  }

  // ── VectorAdapter.upsert ──────────────────────────────────────────────────

  async upsert(items: VectorItem[]): Promise<void> {
    if (items.length === 0) return

    await this.ensureCollection(items)

    const points = items.map((item) => ({
      id: item.id,
      vector: item.embedding,
      payload: { text: item.text, ...item.meta } as Record<string, unknown>,
    }))

    await this.client.upsert(this.collection, { points })
  }

  // ── VectorAdapter.search ──────────────────────────────────────────────────

  async search(embedding: number[], k: number, filter?: Row): Promise<VectorHit[]> {
    const exists = await this.collectionExists()
    if (!exists) return []

    const qdrantFilter: QdrantFilter | undefined =
      filter !== undefined ? rowToQdrantFilter(filter) : undefined

    // The Query API (`query`), not `search`: `search` was removed in client 1.20, while
    // `query` exists from client 1.10 and server 1.10 — the whole peer range we declare.
    const { points } = await this.client.query(this.collection, {
      query: embedding,
      limit: k,
      with_payload: true,
      ...(qdrantFilter !== undefined ? { filter: qdrantFilter } : {}),
    })

    return points.map((point): VectorHit => ({
      id: String(point.id),
      score: point.score,
      meta: (point.payload ?? {}) as Row,
    }))
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async collectionExists(): Promise<boolean> {
    if (this.knownCollections.has(this.collection)) return true
    try {
      const result = await this.client.collectionExists(this.collection)
      if (result.exists) {
        this.knownCollections.add(this.collection)
        return true
      }
      return false
    } catch {
      return false
    }
  }

  private async ensureCollection(items: VectorItem[]): Promise<void> {
    if (this.knownCollections.has(this.collection)) return

    const exists = await this.collectionExists()
    if (exists) return

    // Derive vector size from the first item's embedding length.
    const firstItem = items[0]
    const vectorSize = firstItem !== undefined ? firstItem.embedding.length : 0

    try {
      await this.client.createCollection(this.collection, {
        vectors: {
          size: vectorSize,
          distance: 'Cosine',
        },
      })
      this.knownCollections.add(this.collection)
    } catch (err: unknown) {
      // Swallow "already exists" races — another process may have created it concurrently.
      const msg = err instanceof Error ? err.message : String(err)
      if (
        msg.toLowerCase().includes('already exists') ||
        msg.toLowerCase().includes('conflict')
      ) {
        this.knownCollections.add(this.collection)
        return
      }
      throw err
    }
  }
}

// ── Filter translation ────────────────────────────────────────────────────────
//
// Translates a flat Row (Record<string, unknown>) to a Qdrant Filter whose `must`
// array requires an exact MatchValue on each key.  Values that are not
// string | number | boolean are silently skipped (Qdrant MatchValue only accepts
// those three primitive types).

function rowToQdrantFilter(row: Row): QdrantFilter {
  const conditions: QdrantCondition[] = []

  for (const [key, value] of Object.entries(row)) {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      const fieldCondition: Schemas['FieldCondition'] = {
        key,
        match: { value } satisfies Schemas['MatchValue'],
      }
      conditions.push(fieldCondition)
    }
  }

  if (conditions.length === 0) {
    return {}
  }

  const must: Schemas['Condition'] | Schemas['Condition'][] =
    conditions.length === 1 ? (conditions[0] as Schemas['Condition']) : conditions

  // exactOptionalPropertyTypes: cast through unknown so the loose Qdrant schema
  // union (which includes `| null` on must) doesn't conflict with our non-null value.
  return { must } as unknown as QdrantFilter
}
