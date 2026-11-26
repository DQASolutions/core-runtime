// The EventStore port — the durable, replayable system-of-record change log
// (M2). An Action emits OntologyEvents; the kernel appends them through THIS
// interface inside the write-door transaction. Postgres is only ONE adapter;
// Null / InMemory / (future) event-bus are equally valid impls (ADR — event
// store, product-roadmap.md).
//
// CONTRACT — "event committed iff state committed": `append` runs in the same
// UnitOfWork as the state mutation. An adapter that can join the state backend's
// transaction (same Postgres) does so via `uow.raw`; one that cannot (remote
// bus / other DB) MUST use an outbox to preserve the guarantee.

import type { OntologyEvent } from '../types/index.js'
import type { UnitOfWork } from './storage-adapter.js'

export interface ChainVerdict {
  ok: boolean
  count: number
  /** seq (0-based stream position) of the first event that fails to verify. */
  brokenAt?: number
}

export interface EventStore {
  /**
   * Persist the events an Action emitted, atomically with the state mutation.
   * The store is the authority for per-aggregate `version` (overrides the v1 the
   * action runtime stamps). Same-backend impls enlist in `uow.raw`; others outbox.
   */
  append(events: OntologyEvent[], uow: UnitOfWork): Promise<void>

  /** Replay one aggregate's events in ascending `version` order. */
  read(tenantId: string, aggregateId: string): Promise<OntologyEvent[]>

  /** Replay the whole tenant stream from a global cursor (0 = from the start). */
  scan(tenantId: string, fromSeq?: number): Promise<OntologyEvent[]>

  /** Recompute the tamper-evident hash chain; report the first event that fails
   *  to verify (edited/deleted/reordered). OPTIONAL — stores without a durable
   *  chain (Null) omit it. */
  verify?(tenantId: string): Promise<ChainVerdict>

  /** Dispose any long-lived resource (pool). Backends without one omit it. */
  close?(): Promise<void>
}
