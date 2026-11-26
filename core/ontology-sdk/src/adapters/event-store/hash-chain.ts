// Tamper-evident chain for the event store (M2). Each event carries
// hash = sha256(prevHash + canonical(event)), prevHash = the prior event's hash
// in the tenant stream (GENESIS for the first). Editing/deleting any event breaks
// the chain from that point, so verify() can point at the first altered event.
// Mirrors the case-ledger scheme in engine/fieldos/src/trace.ts (kept local so
// the ontology package takes no cross-package dep).

import crypto from 'node:crypto'
import type { OntologyEvent } from '../../types/index.js'

export const GENESIS = '0'.repeat(64)

/** Stable, key-sorted JSON so the hash is independent of property order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`
}

/** sha256(prevHash + canonical(event identity fields)). */
export function hashEvent(prevHash: string, e: OntologyEvent): string {
  const body = {
    id: e.id,
    ts: e.ts,
    type: e.type,
    aggregate: e.aggregate,
    payload: e.payload,
    actor: e.actor,
    version: e.version,
  }
  return crypto.createHash('sha256').update(prevHash + canonical(body)).digest('hex')
}

export interface ChainVerdict {
  ok: boolean
  count: number
  /** seq (0-based stream position) of the first event that fails to verify. */
  brokenAt?: number
}
