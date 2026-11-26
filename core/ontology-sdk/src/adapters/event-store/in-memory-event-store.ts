// InMemoryEventStore — Map-backed append-only log. The parity/test backend and
// the fast inner-loop dev store. Authority for per-aggregate `version` (overrides
// the v1 the action runtime stamps) and a tenant-global insertion order (`scan`).
// Each event is hash-chained (tamper-evident); `verify` recomputes the chain.
// Atomicity with state is provided by the StorageAdapter's withTransaction (the
// InMemoryAdapter snapshots/restores); this store appends last, so a thrown
// append leaves nothing pushed.

import type { EventStore } from '../../ports/event-store.js'
import type { UnitOfWork } from '../../ports/storage-adapter.js'
import type { OntologyEvent } from '../../types/index.js'
import { type ChainVerdict, GENESIS, hashEvent } from './hash-chain.js'

interface StoredEvent extends OntologyEvent {
  prevHash: string
  hash: string
}

function strip(e: StoredEvent): OntologyEvent {
  const { prevHash: _p, hash: _h, ...rest } = e
  return rest
}

export class InMemoryEventStore implements EventStore {
  // tenantId → append-ordered, hash-chained event log
  private readonly logs = new Map<string, StoredEvent[]>()

  private log(tenantId: string): StoredEvent[] {
    let l = this.logs.get(tenantId)
    if (!l) {
      l = []
      this.logs.set(tenantId, l)
    }
    return l
  }

  async append(events: OntologyEvent[], uow: UnitOfWork): Promise<void> {
    const log = this.log(uow.tenantId)
    let prev = log.length > 0 ? log[log.length - 1]!.hash : GENESIS
    for (const e of events) {
      // store is the version authority: next per-aggregate version
      const priorCount = log.reduce((n, x) => (x.aggregate === e.aggregate ? n + 1 : n), 0)
      const versioned: OntologyEvent = { ...e, version: priorCount + 1 }
      const hash = hashEvent(prev, versioned)
      log.push({ ...versioned, prevHash: prev, hash })
      prev = hash
    }
  }

  async read(tenantId: string, aggregateId: string): Promise<OntologyEvent[]> {
    return this.log(tenantId)
      .filter((e) => e.aggregate === aggregateId)
      .sort((a, b) => a.version - b.version)
      .map(strip)
  }

  async scan(tenantId: string, fromSeq = 0): Promise<OntologyEvent[]> {
    return this.log(tenantId).slice(fromSeq).map(strip)
  }

  async verify(tenantId: string): Promise<ChainVerdict> {
    const log = this.log(tenantId)
    let prev = GENESIS
    for (let i = 0; i < log.length; i++) {
      const e = log[i]!
      if (e.prevHash !== prev || hashEvent(prev, strip(e)) !== e.hash) {
        return { ok: false, count: log.length, brokenAt: i }
      }
      prev = e.hash
    }
    return { ok: true, count: log.length }
  }
}
