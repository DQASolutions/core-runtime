import { defineConfig } from 'tsup'

// ESM and CJS, like @dqa-ai-solutions/ontology-sdk: the sdk's CJS build requires this package.
export default defineConfig({
  entry: { index: 'src/index.ts' },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: false,
  target: 'es2022',
})
