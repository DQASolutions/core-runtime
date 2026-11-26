import { defineConfig } from 'vitest/config'

// Performance-isolated vitest config — runs NFR-P01 tests sequentially in a
// single fork to reduce timing noise (GAP-N07 resolution).
// Usage: npx vitest run --config vitest.perf.config.ts
export default defineConfig({
  test: {
    // Only include tests whose describe/it strings contain NFR-P01
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // One fork, one file at a time (vitest 4 dropped poolOptions.forks.singleFork).
    pool: 'forks',
    maxWorkers: 1,
    fileParallelism: false,
  },
})
