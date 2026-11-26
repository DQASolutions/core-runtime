// Enforces ADR-0001 / QG-1 / QG-2: Layer-2 (core) and Layer-3 (api) must never
// import Layer-1 (adapters) or a backend library. Mechanical, not by review.
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint', 'boundaries'],
  settings: {
    'boundaries/elements': [
      { type: 'types', pattern: 'src/types/*' },
      { type: 'shared', pattern: 'src/shared/*' },
      { type: 'api', pattern: 'src/api/*' },
      { type: 'core', pattern: 'src/core/*' },
      { type: 'ports', pattern: 'src/ports/*' },
      { type: 'adapters', pattern: 'src/adapters/*' },
    ],
  },
  rules: {
    // QG-1: api/core may use ports + the shared types kernel; nothing in
    // api/core may reach into adapters. `types` is a pure-type shared kernel
    // every layer (incl. Layer-1 adapters) may import.
    'boundaries/element-types': [
      'error',
      {
        default: 'disallow',
        rules: [
          { from: 'types', allow: ['types'] },
          { from: 'shared', allow: ['shared', 'types'] },
          { from: 'api', allow: ['api', 'core', 'ports', 'types', 'shared'] },
          { from: 'core', allow: ['core', 'ports', 'types', 'shared'] },
          { from: 'ports', allow: ['ports', 'types'] },
          { from: 'adapters', allow: ['adapters', 'ports', 'types', 'shared'] },
        ],
      },
    ],
    // QG-2: backend libraries may be imported only inside src/adapters/**.
    'no-restricted-imports': [
      'error',
      {
        paths: [
          { name: 'pg', message: 'Backend driver allowed only in src/adapters/** (QG-2/NT2).' },
          { name: 'drizzle-orm', message: 'Backend ORM allowed only in src/adapters/** (QG-2/NT2).' },
          { name: '@qdrant/js-client-rest', message: 'Vector client allowed only in src/adapters/** (QG-2/NT5).' },
        ],
      },
    ],
  },
  overrides: [
    {
      // The adapters layer is the one place backends are allowed.
      files: ['src/adapters/**/*.ts'],
      rules: { 'no-restricted-imports': 'off' },
    },
  ],
  // src/index.ts is the package composition root (wires api + adapters like a
  // consumer app) — exempt from the layer-boundary rule by design.
  ignorePatterns: ['dist', 'node_modules', '.dqa', '*.config.ts', 'src/index.ts'],
}
