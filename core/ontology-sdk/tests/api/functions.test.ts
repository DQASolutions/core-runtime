/**
 * Function runtime (E1.2): named pure compute over the graph — callFunction,
 * memoization (cache hit), cache invalidation on write.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createOntology, InMemoryAdapter, OntologyError, type Ontology } from '../../src/index.js'

const ctx = { tenantId: 't1' }
const prov = { source_ref: 'src', confirmed_by: 'u', confirmed_at: '2026-01-01T00:00:00.000Z' }

let ont: Ontology

beforeEach(async () => {
  ont = createOntology({ adapter: new InMemoryAdapter() })
  await ont.defineEntityType({ name: 'doc', label: 'Doc', properties: [] }, ctx)
})

async function rejectsWith(p: Promise<unknown>, code: string) {
  let caught: unknown
  try { await p } catch (e) { caught = e }
  expect(caught).toBeInstanceOf(OntologyError)
  expect((caught as OntologyError).code).toBe(code)
}

describe('callFunction — pure compute', () => {
  it('computes over the graph via the read IO', async () => {
    await ont.defineFunctionImpl(
      { def: { name: 'docCount' }, body: async (_a, _c, io) => (await io.find('doc')).length },
      ctx,
    )
    await ont.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx)
    await ont.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx)
    expect(await ont.callFunction('docCount', {}, ctx)).toBe(2)
  })

  it('memoizes per (name, args) and invalidates on write', async () => {
    let runs = 0
    await ont.defineFunctionImpl(
      { def: { name: 'docCount' }, body: async (_a, _c, io) => { runs++; return (await io.find('doc')).length } },
      ctx,
    )
    await ont.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx)

    expect(await ont.callFunction('docCount', {}, ctx)).toBe(1)
    expect(await ont.callFunction('docCount', {}, ctx)).toBe(1)
    expect(runs).toBe(1) // second call served from cache

    // a write invalidates the memo cache → recompute
    await ont.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx)
    expect(await ont.callFunction('docCount', {}, ctx)).toBe(2)
    expect(runs).toBe(2)
  })

  it('caches distinct args separately', async () => {
    await ont.defineFunctionImpl(
      { def: { name: 'echo' }, body: (args) => Number(args.n) * 2 },
      ctx,
    )
    expect(await ont.callFunction('echo', { n: 3 }, ctx)).toBe(6)
    expect(await ont.callFunction('echo', { n: 5 }, ctx)).toBe(10)
  })

  it('rejects an unknown function', async () => {
    await rejectsWith(ont.callFunction('nope', {}, ctx), 'FUNCTION_NOT_FOUND')
  })

  it('a declared-but-unbound function throws FUNCTION_NOT_BOUND', async () => {
    await ont.defineFunction({ name: 'bare', returns: 'number' }, ctx)
    await rejectsWith(ont.callFunction('bare', {}, ctx), 'FUNCTION_NOT_BOUND')
  })
})
