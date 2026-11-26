import { defineConfig } from 'tsup'

export default defineConfig({
  // `input` is the typed-input parser without the storage adapters — a browser
  // bundle imports it and never meets `pg`.
  entry: { index: 'src/index.ts', input: 'src/input/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: false,
  target: 'es2022',
  // load-driver.ts uses import.meta.url; shims gives the CJS build one too.
  shims: true,
  // Backend libs are peer/optional — never inline them into the bundle.
  external: ['pg', '@qdrant/js-client-rest', 'neo4j-driver'],
})
