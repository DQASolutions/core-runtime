// Layer 3 — composition entry. The consuming app supplies concrete Layer-1
// adapter instances; the core only ever sees the StorageAdapter / VectorAdapter
// interfaces (development-view §2 — dependency injection across the boundary).

import { Ontology, type OntologyDeps } from './ontology.js'

export function createOntology(deps: OntologyDeps): Ontology {
  return new Ontology(deps)
}
