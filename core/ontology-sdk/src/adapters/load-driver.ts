// Backend drivers (pg, neo4j-driver, @qdrant/js-client-rest) are optional peer
// dependencies. They are loaded here, when an adapter that needs one is built —
// never at import time — so `import '@dqa-ai-solutions/ontology-sdk'` works with none of them
// installed, and an app that only uses the in-memory adapter installs none.
import { createRequire } from 'node:module'

import { ontologyError } from '../types/index.js'

const load = createRequire(import.meta.url)

export function loadDriver<T>(pkg: string, adapter: string): T {
  try {
    return load(pkg) as T
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND') {
      throw ontologyError('ADAPTER_DRIVER_MISSING', `${adapter} needs the "${pkg}" package — install it alongside @dqa-ai-solutions/ontology-sdk`, { package: pkg, cause: err })
    }
    throw err
  }
}
