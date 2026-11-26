// NullEventStore — the EXPLICIT "do not persist" choice. Append is a no-op;
// replay always empty. Selecting this must be a conscious decision (dev /
// ephemeral): the kernel never silently falls back to it for a regulated run —
// composition wires it on purpose (ADR — event store, product-roadmap.md).

import type { EventStore } from '../../ports/event-store.js'
import type { ChainVerdict } from './hash-chain.js'
import type { OntologyEvent } from '../../types/index.js'

export class NullEventStore implements EventStore {
  async append(): Promise<void> {
    /* intentionally nothing */
  }
  async read(): Promise<OntologyEvent[]> {
    return []
  }
  async scan(): Promise<OntologyEvent[]> {
    return []
  }
  async verify(): Promise<ChainVerdict> {
    return { ok: true, count: 0 }
  }
}
