/**
 * EventStore wiring (M2): applyAction appends emitted events through the built-in
 * EventStore inside the write-door unit of work. Verifies persistence, per-aggregate
 * versioning (the store is the version authority, fixing the v1 stamp), tenant-stream
 * scan, and atomicity (a failing append rolls back the state mutation).
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  createOntology,
  InMemoryAdapter,
  InMemoryEventStore,
  type EventStore,
  type Ontology,
  type OntologyEvent,
  type UnitOfWork,
} from '../../src/index.js'

const ctx = { tenantId: 't1' }
const prov = { source_ref: 'src', confirmed_by: 'u', confirmed_at: '2026-01-01T00:00:00.000Z' }

let events: InMemoryEventStore
let ont: Ontology

beforeEach(async () => {
  events = new InMemoryEventStore()
  ont = createOntology({ adapter: new InMemoryAdapter(), eventStore: events })
  await ont.defineEntityType({ name: 'doc', label: 'Doc', properties: [] }, ctx)
})

describe('EventStore — append on applyAction', () => {
  it('persists the emitted event, replayable per aggregate', async () => {
    const e = (await ont.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx))[0]!
    const log = await events.read('t1', e.aggregate)
    expect(log).toHaveLength(1)
    expect(log[0]!.type).toBe('instance.created')
    expect(log[0]!.version).toBe(1)
  })

  it('is the version authority — per-aggregate version increments', async () => {
    const created = (await ont.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx))[0]!
    await ont.applyAction('updateInstance', { id: created.aggregate, patch: {} }, prov, ctx)
    const log = await events.read('t1', created.aggregate)
    expect(log.map((x) => x.version)).toEqual([1, 2])
  })

  it('scan returns the tenant-global stream', async () => {
    await ont.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx)
    await ont.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx)
    expect(await events.scan('t1')).toHaveLength(2)
  })

  it('isolates per tenant', async () => {
    await ont.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx)
    expect(await events.scan('t2')).toHaveLength(0)
  })
})

describe('EventStore — tamper-evident chain', () => {
  it('verify() returns ok for an intact chain', async () => {
    await ont.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx)
    await ont.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx)
    expect(await events.verify!('t1')).toEqual({ ok: true, count: 2 })
  })
})

describe('EventStore — atomicity with state (withTransaction)', () => {
  it('rolls back the state mutation when the append fails', async () => {
    const boom: EventStore = {
      async append(_e: OntologyEvent[], _uow: UnitOfWork) {
        throw new Error('event store down')
      },
      async read() {
        return []
      },
      async scan() {
        return []
      },
    }
    const o = createOntology({ adapter: new InMemoryAdapter(), eventStore: boom })
    await o.defineEntityType({ name: 'doc', label: 'Doc', properties: [] }, ctx)

    await expect(
      o.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx),
    ).rejects.toThrow('event store down')

    // atomic: the instance the effect created must NOT survive the failed append
    expect(await o.find('doc', undefined, ctx)).toHaveLength(0)
  })
})
