// Non-code files a one-import package re-serves from the packages it gathers: the ontology file
// schema, conformance cases and the rule registry's SQL migrations (ontology-runtime), the theme
// stylesheets (ui-runtime), the ingested-context JSON Schema (agent-runtime).
// Run from the package directory: `node ../../scripts/copy-assets.mjs <package>`.
import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

// Where npm put a package, looked up the way Node does: node_modules of this directory, then of
// each parent. Not `require.resolve`: these packages export neither `./package.json` nor `require`.
const root = (name) => {
  for (let d = process.cwd(); ; d = dirname(d)) {
    const at = join(d, 'node_modules', name)
    if (existsSync(join(at, 'package.json'))) return at
    if (dirname(d) === d) throw new Error(`copy-assets: ${name} is not installed`)
  }
}
const COPIES = {
  'core-runtime': [
    ['@dqa-ai-solutions/ontology-base', 'schema', 'dist/ontology-base/schema'],
    ['@dqa-ai-solutions/ontology-base', 'conformance', 'dist/ontology-base/conformance'],
  ],
  'ontology-runtime': [
    ['@dqa-ai-solutions/module-rule-registry', 'migrations', 'dist/rule-registry/migrations'],
  ],
  'agent-runtime': [
    ['@dqa-ai-solutions/ingest-documents', 'schemas', 'dist/ingest-documents/schemas'],
  ],
  'ui-runtime': ['tokens.css', 'tokens.generated.css', 'tokens.dark.css', 'tokens.high.css']
    .map((f) => ['@dqa-ai-solutions/ui-kit', `dist/${f}`, `dist/${f}`]),
}
const which = process.argv[2]
if (!COPIES[which]) throw new Error(`copy-assets: no assets declared for "${which}"`)
for (const [pkg, from, to] of COPIES[which]) {
  mkdirSync(dirname(to), { recursive: true })
  cpSync(join(root(pkg), from), to, { recursive: true })
}
