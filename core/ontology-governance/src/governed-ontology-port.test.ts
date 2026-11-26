import { describe, it, expect, beforeEach } from 'vitest'
import { createOntology, InMemoryAdapter, type OntologyPort } from '@dqa-ai-solutions/ontology-sdk'
import {
  GovernedOntologyPort,
  GovernanceError,
  auditInterceptor,
  rbacInterceptor,
  type AuditRecord,
} from './index.js'

const ctx = { tenantId: 't1', actor: 'alice' }
const prov = { source_ref: 'src', confirmed_by: 'alice', confirmed_at: '2026-01-01T00:00:00.000Z' }

let inner: OntologyPort

beforeEach(async () => {
  inner = createOntology({ adapter: new InMemoryAdapter() })
  await inner.defineEntityType({ name: 'doc', label: 'Doc', properties: [] }, ctx)
})

describe('GovernedOntologyPort', () => {
  it('passes applyAction through to the inner port and records an audit entry', async () => {
    const audit: AuditRecord[] = []
    const gov = new GovernedOntologyPort(inner, [auditInterceptor((r) => { audit.push(r) })])

    const events = await gov.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx)
    expect(events).toHaveLength(1)

    // the write actually happened on the inner ontology
    expect(await gov.find('doc', undefined, ctx)).toHaveLength(1)
    // and was audited
    expect(audit).toHaveLength(1)
    expect(audit[0]).toMatchObject({ action: 'createInstance', actor: 'alice', events: 1 })
  })

  it('RBAC before-interceptor rejects a denied action (and the write does not happen)', async () => {
    const gov = new GovernedOntologyPort(inner, [
      rbacInterceptor((action) => action !== 'createInstance'), // deny createInstance
    ])
    await expect(gov.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx)).rejects.toBeInstanceOf(GovernanceError)
    expect(await gov.find('doc', undefined, ctx)).toHaveLength(0) // nothing written
  })

  it('RBAC allows a permitted action', async () => {
    const gov = new GovernedOntologyPort(inner, [rbacInterceptor(() => true)])
    await gov.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx)
    expect(await gov.find('doc', undefined, ctx)).toHaveLength(1)
  })

  it('runs the chain in order: RBAC (before) gates audit (after)', async () => {
    const audit: AuditRecord[] = []
    const gov = new GovernedOntologyPort(inner, [
      rbacInterceptor((action) => action !== 'createInstance'),
      auditInterceptor((r) => { audit.push(r) }),
    ])
    await expect(gov.applyAction('createInstance', {}, prov, ctx)).rejects.toBeInstanceOf(GovernanceError)
    expect(audit).toHaveLength(0) // denied before the effect → never audited
  })

  it('reads pass through unchanged', async () => {
    const gov = new GovernedOntologyPort(inner)
    await gov.applyAction('createInstance', { type: 'doc', props: {} }, prov, ctx)
    const all = await gov.find('doc', undefined, ctx)
    expect(all).toHaveLength(1)
    expect(await gov.get(all[0].id, ctx)).not.toBeNull()
  })

  it('is itself a valid OntologyPort (decorator conformance)', () => {
    const port: OntologyPort = new GovernedOntologyPort(inner)
    expect(typeof port.applyAction).toBe('function')
    expect(typeof port.evaluateRules).toBe('function')
  })
})
