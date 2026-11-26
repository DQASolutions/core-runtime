/**
 * Idempotent ingest (5.1) — the regression guard for the duplicate-graph bug.
 *
 * Root cause: `createInstance` mints a random UUID per write, so an interrupted
 * load that retries (or a customer re-running after adding data) duplicated the
 * whole graph. Fix: `upsertInstance` keys the id deterministically off a stable
 * `ref`, so re-applying the same payload converges instead of duplicating. Plus
 * `clearTenant` for an explicit clean-slate reset.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  createOntology,
  InMemoryAdapter,
  FilesystemAdapter,
  idFor,
  uuidv5,
  type Ontology,
  type StorageAdapter,
} from '../../src/index.js'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ctx = { tenantId: 't1' }
const prov = { source_ref: 'src', confirmed_by: 'u', confirmed_at: '2026-01-01T00:00:00.000Z' }

describe('deterministic id', () => {
  it('uuidv5 matches the RFC reference vector', () => {
    expect(uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    )
  })

  it('idFor is stable across calls and varies by tenant/type/ref', () => {
    expect(idFor('t1', 'SoDuTK', 'sodu-111')).toBe(idFor('t1', 'SoDuTK', 'sodu-111'))
    expect(idFor('t1', 'SoDuTK', 'sodu-111')).not.toBe(idFor('t2', 'SoDuTK', 'sodu-111'))
    expect(idFor('t1', 'SoDuTK', 'sodu-111')).not.toBe(idFor('t1', 'SoDuTK', 'sodu-112'))
    expect(idFor('t1', 'SoDuTK', 'sodu-111')).not.toBe(idFor('t1', 'SoChiTiet', 'sodu-111'))
  })
})

function suite(name: string, makeAdapter: () => Promise<StorageAdapter> | StorageAdapter) {
  describe(`idempotent upsert + reset — ${name}`, () => {
    let ont: Ontology
    let adapter: StorageAdapter

    beforeEach(async () => {
      adapter = await makeAdapter()
      ont = createOntology({ adapter })
      await ont.defineEntityType(
        { name: 'doc', label: 'Doc', properties: [{ name: 'v', type: 'number' }] },
        ctx,
      )
    })

    it('upsertInstance twice with the same ref → ONE instance, last write wins', async () => {
      const e1 = await ont.applyAction('upsertInstance', { type: 'doc', ref: 'a', props: { v: 1 } }, prov, ctx)
      const e2 = await ont.applyAction('upsertInstance', { type: 'doc', ref: 'a', props: { v: 2 } }, prov, ctx)
      expect(e1[0]!.aggregate).toBe(e2[0]!.aggregate) // same deterministic id
      expect(e2[0]!.type).toBe('instance.upserted')

      const all = await ont.find('doc', undefined, ctx)
      expect(all).toHaveLength(1) // NOT duplicated
      expect(all[0]!.data.v).toBe(2) // refreshed
      expect(all[0]!.id).toBe(idFor('t1', 'doc', 'a'))
    })

    it('re-running a whole ref-keyed payload is idempotent (instances + edges)', async () => {
      await ont.defineRelationshipType(
        { name: 'rel', from: 'doc', to: 'doc', cardinality: 'N..N', directed: true },
        ctx,
      )
      const load = async (): Promise<void> => {
        const a = await ont.applyAction('upsertInstance', { type: 'doc', ref: 'a', props: { v: 1 } }, prov, ctx)
        const b = await ont.applyAction('upsertInstance', { type: 'doc', ref: 'b', props: { v: 2 } }, prov, ctx)
        await ont.applyAction('link', { relationship: 'rel', from: a[0]!.aggregate, to: b[0]!.aggregate }, prov, ctx)
      }
      await load()
      await load() // simulate the interrupted-then-retried ingest

      expect(await ont.find('doc', undefined, ctx)).toHaveLength(2)
      const a = idFor('t1', 'doc', 'a')
      const neighbours = await ont.neighbors(a, 'rel', ctx)
      expect(neighbours).toHaveLength(1) // edge not duplicated either
    })

    it('clearTenant wipes the tenant; a later load starts clean', async () => {
      await ont.applyAction('upsertInstance', { type: 'doc', ref: 'a', props: { v: 1 } }, prov, ctx)
      expect(await ont.find('doc', undefined, ctx)).toHaveLength(1)

      await adapter.withTenant('t1').clearTenant()

      // Re-register schema (clear also drops the persisted schema snapshot) then read.
      ont = createOntology({ adapter })
      await ont.defineEntityType(
        { name: 'doc', label: 'Doc', properties: [{ name: 'v', type: 'number' }] },
        ctx,
      )
      expect(await ont.find('doc', undefined, ctx)).toHaveLength(0)
    })
  })
}

suite('in-memory', () => new InMemoryAdapter())
suite('filesystem', async () => new FilesystemAdapter(await mkdtemp(join(tmpdir(), 'fs-idem-'))))
