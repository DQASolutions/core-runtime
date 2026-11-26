// Deterministic instance ids — the seam that makes ingest idempotent.
//
// A random UUID per write means "load the same case twice" duplicates the whole
// graph (an interrupted run that retries, or a customer re-running after adding
// data). Instead, an instance carrying a stable business key (`ref`) gets a
// DETERMINISTIC id: the same (tenant, type, ref) always maps to the same UUID,
// so a re-run upserts the same node and `link()` (already edge-idempotent)
// reconnects it — no duplicates. No external dep: RFC-4122 v5 over SHA-1.

import { createHash } from 'node:crypto'

// Fixed namespace for the DQA ontology. Any constant 16-byte UUID works — it
// only seeds the hash; changing it would re-key every deterministic id, so it
// MUST stay stable across releases.
const DQA_NAMESPACE = 'b6e3f1a2-7c84-4d59-9f3b-0a1c2d3e4f50'

// Field separator for idFor() — a control char that cannot appear in a tenant
// id / entity type / ref, so distinct triples can never collide via the join.
const SEP = String.fromCharCode(0x1f)

/** Parse a canonical UUID string into its 16 raw bytes. */
function uuidBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '')
  if (hex.length !== 32) throw new Error(`invalid UUID: ${uuid}`)
  return Buffer.from(hex, 'hex')
}

/** Format 16 bytes as a canonical UUID string. */
function formatUuid(bytes: Buffer): string {
  const h = bytes.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/** RFC-4122 v5 UUID: SHA-1(namespace-bytes ++ name) with version/variant bits set. */
export function uuidv5(name: string, namespace: string = DQA_NAMESPACE): string {
  const hash = createHash('sha1')
    .update(uuidBytes(namespace))
    .update(Buffer.from(name, 'utf8'))
    .digest()
  const bytes = hash.subarray(0, 16)
  bytes[6] = (bytes[6]! & 0x0f) | 0x50 // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // RFC-4122 variant
  return formatUuid(bytes)
}

/**
 * Deterministic instance id for a (tenant, entityType, ref) triple. The control
 * separator keeps the three fields unambiguous so distinct triples can never
 * collide via concatenation.
 */
export function idFor(tenantId: string, entityType: string, ref: string): string {
  return uuidv5([tenantId, entityType, ref].join(SEP))
}
