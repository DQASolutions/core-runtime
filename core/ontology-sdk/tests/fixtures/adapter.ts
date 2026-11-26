/**
 * Shared adapter fixture for the test suite.
 *
 * Selects the StorageAdapter implementation based on the TEST_ADAPTER
 * environment variable (default: "memory").
 *
 * Usage:
 *   import { createTestAdapter } from '../fixtures/adapter.js'
 *   const adapter = createTestAdapter()
 *
 * QG-5: TEST_ADAPTER=memory npm test  (in-memory, fast, always available)
 *       TEST_ADAPTER=postgres npm test (postgres, requires DATABASE_URL)
 */

import { InMemoryAdapter, PostgresAdapter, Neo4jAdapter, type StorageAdapter } from '../../src/index.js'

export type TestAdapterKind = 'memory' | 'postgres' | 'neo4j'

export function createTestAdapter(): StorageAdapter {
  const kind: TestAdapterKind = (process.env['TEST_ADAPTER'] as TestAdapterKind) ?? 'memory'

  if (kind === 'postgres') {
    const connectionString =
      process.env['DATABASE_URL'] ??
      'postgresql://ontology:ontology@localhost:5432/ontology_test'
    return new PostgresAdapter({ connectionString })
  }

  if (kind === 'neo4j') {
    // Reads NEO4J_URL / NEO4J_USER / NEO4J_PASSWORD from env (defaults to
    // bolt://localhost:7687, neo4j/neo4j). QG-5: TEST_ADAPTER=neo4j vitest run.
    return new Neo4jAdapter()
  }

  return new InMemoryAdapter()
}

export { InMemoryAdapter, PostgresAdapter, Neo4jAdapter }
