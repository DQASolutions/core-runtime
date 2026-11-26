/**
 * K3 — writeGate: 'actions-only'.
 *
 * Only applyAction() appends to the change log. A direct create()/link() moves
 * state while the ledger shows nothing, and nothing at the call site says so —
 * which is why apps that care about the audit trail end up writing their own
 * linter to forbid it. This turns that convention into a runtime refusal, with
 * one written-down exemption for provisioning.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createOntology, InMemoryAdapter, OntologyError, type Ontology } from '../../src/index.js'

const ctx = { tenantId: 't1' }
const prov = { source_ref: 'src', confirmed_by: 'u', confirmed_at: '2026-01-01T00:00:00.000Z' }

async function schema(ont: Ontology) {
  await ont.asBootstrap(async () => {
    await ont.defineEntityType(
      { name: 'doc', label: 'Doc', properties: [{ name: 'title', type: 'text' }] },
      ctx,
    )
    await ont.defineRelationshipType(
      { name: 'cites', from: 'doc', to: 'doc', cardinality: 'N..N', directed: true },
      ctx,
    )
  })
}

async function rejectsWith(p: Promise<unknown>, code: string) {
  let caught: unknown
  try { await p } catch (e) { caught = e }
  expect(caught).toBeInstanceOf(OntologyError)
  expect((caught as OntologyError).code).toBe(code)
}

describe('K3 · default is open — nothing changes for existing callers', () => {
  it('a direct create still works when no gate is configured', async () => {
    const ont = createOntology({ adapter: new InMemoryAdapter() })
    await schema(ont)
    const inst = await ont.create('doc', { title: 'a' }, prov, ctx)
    expect(inst.id).toBeTruthy()
  })

  it('asBootstrap is a harmless no-op when the gate is open', async () => {
    const ont = createOntology({ adapter: new InMemoryAdapter() })
    await schema(ont)
    const inst = await ont.asBootstrap(() => ont.create('doc', { title: 'a' }, prov, ctx))
    expect(inst.id).toBeTruthy()
  })
})

describe('K3 · actions-only refuses each primitive write', () => {
  let ont: Ontology
  let a: string
  let b: string

  beforeEach(async () => {
    ont = createOntology({ adapter: new InMemoryAdapter(), writeGate: 'actions-only' })
    await schema(ont)
    await ont.asBootstrap(async () => {
      a = (await ont.create('doc', { title: 'a' }, prov, ctx)).id
      b = (await ont.create('doc', { title: 'b' }, prov, ctx)).id
    })
  })

  it('create', async () => {
    await rejectsWith(ont.create('doc', { title: 'x' }, prov, ctx), 'WRITE_OUTSIDE_ACTION')
  })

  it('upsert', async () => {
    await rejectsWith(ont.upsert('doc', 'ref-1', { title: 'x' }, prov, ctx), 'WRITE_OUTSIDE_ACTION')
  })

  it('update', async () => {
    await rejectsWith(ont.update(a, { title: 'x' }, prov, ctx), 'WRITE_OUTSIDE_ACTION')
  })

  it('link', async () => {
    await rejectsWith(ont.link('cites', a, b, prov, ctx), 'WRITE_OUTSIDE_ACTION')
  })

  it('unlink', async () => {
    await ont.asBootstrap(() => ont.link('cites', a, b, prov, ctx))
    await rejectsWith(ont.unlink('cites', a, b, prov, ctx), 'WRITE_OUTSIDE_ACTION')
  })

  it('says WHY, so the reader knows what to do instead', async () => {
    let caught: unknown
    try { await ont.create('doc', { title: 'x' }, prov, ctx) } catch (e) { caught = e }
    const msg = (caught as Error).message
    expect(msg).toContain('change log')
    expect(msg).toContain('applyAction')
    expect(msg).toContain('asBootstrap')
  })

  it('leaves reads alone', async () => {
    expect(await ont.get(a, ctx)).not.toBeNull()
    expect(await ont.find('doc', undefined, ctx)).toHaveLength(2)
  })
})

describe('K3 · the governed door still opens', () => {
  it('applyAction writes through the same primitives and is allowed', async () => {
    const ont = createOntology({ adapter: new InMemoryAdapter(), writeGate: 'actions-only' })
    await schema(ont)
    const events = await ont.applyAction('createInstance', { type: 'doc', props: { title: 'via action' } }, prov, ctx)
    expect(events).toHaveLength(1)
    expect(events[0]!.type).toBe('instance.created')
    expect(await ont.find('doc', undefined, ctx)).toHaveLength(1)
  })

  it('the gate closes again after the action returns', async () => {
    const ont = createOntology({ adapter: new InMemoryAdapter(), writeGate: 'actions-only' })
    await schema(ont)
    await ont.applyAction('createInstance', { type: 'doc', props: { title: 'x' } }, prov, ctx)
    await rejectsWith(ont.create('doc', { title: 'after' }, prov, ctx), 'WRITE_OUTSIDE_ACTION')
  })

  it('a direct write running CONCURRENTLY with an action is still refused', async () => {
    // The reason the gate is scoped to the call stack and not to a counter: a
    // counter would be set for anything in flight, so this would slip through
    // depending on timing.
    const ont = createOntology({ adapter: new InMemoryAdapter(), writeGate: 'actions-only' })
    await schema(ont)

    const [, stray] = await Promise.allSettled([
      ont.applyAction('createInstance', { type: 'doc', props: { title: 'legit' } }, prov, ctx),
      ont.create('doc', { title: 'stray' }, prov, ctx),
    ])

    expect(stray.status).toBe('rejected')
    expect(((stray as PromiseRejectedResult).reason as OntologyError).code)
      .toBe('WRITE_OUTSIDE_ACTION')
    // the legitimate one landed; the stray one did not
    const docs = await ont.find('doc', undefined, ctx)
    expect(docs.map((d) => d.data['title'])).toEqual(['legit'])
  })
})

describe('K3 · one scope for the process, one door per instance', () => {
  async function gated() {
    const ont = createOntology({ adapter: new InMemoryAdapter(), writeGate: 'actions-only' })
    await schema(ont)
    return ont
  }

  it('an instance holds no AsyncLocalStorage of its own', async () => {
    // Apps build an Ontology per request. On Node <= 22 every AsyncLocalStorage
    // that has run() stays in a global list each new promise walks — one per
    // instance made every await slower for the life of the process.
    const ont = await gated()
    await ont.applyAction('createInstance', { type: 'doc', props: { title: 'x' } }, prov, ctx)
    expect(Object.values(ont).some((v) => v instanceof AsyncLocalStorage)).toBe(false)
  })

  it('an action on one instance opens no door on another', async () => {
    const a = await gated()
    const b = await gated()
    const [, stray] = await Promise.allSettled([
      a.applyAction('createInstance', { type: 'doc', props: { title: 'legit' } }, prov, ctx),
      b.create('doc', { title: 'stray' }, prov, ctx),
    ])
    expect(stray.status).toBe('rejected')
    expect(((stray as PromiseRejectedResult).reason as OntologyError).code).toBe('WRITE_OUTSIDE_ACTION')
    await a.asBootstrap(() => rejectsWith(b.create('doc', { title: 'nested' }, prov, ctx), 'WRITE_OUTSIDE_ACTION'))
  })

  it("a scope nested inside another instance's keeps the outer door open", async () => {
    const a = await gated()
    const b = await gated()
    await a.asBootstrap(() =>
      b.asBootstrap(async () => {
        await b.create('doc', { title: 'b' }, prov, ctx)
        await a.create('doc', { title: 'a' }, prov, ctx)
      }),
    )
    expect(await a.find('doc', undefined, ctx)).toHaveLength(1)
    expect(await b.find('doc', undefined, ctx)).toHaveLength(1)
    await rejectsWith(a.create('doc', { title: 'after' }, prov, ctx), 'WRITE_OUTSIDE_ACTION')
  })
})
