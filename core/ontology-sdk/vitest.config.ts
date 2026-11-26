import { defineConfig } from 'vitest/config'

// TEST_ADAPTER (memory | postgres) selects the parity fixture's backend.
// QDRANT_URL, when set, enables the live Qdrant integration test.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
