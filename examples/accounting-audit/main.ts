// Dogfood example — drives the @dqa-ai-solutions/ontology-sdk public surface end-to-end
// (in-memory backend for §1–9, then FilesystemAdapter §10 and an opt-in
// PostgresAdapter §11 parity check), modelling an accounting-audit workflow.
//
// Run:   npm start   (from this folder)
// (Node >= 22.6 strips the TypeScript types natively; no build step needed.)
//
// It exercises every public capability a downstream consumer relies on:
//   schema  → defineEntityType / defineRelationshipType / migrate / getSchema
//   data    → create / update / get / find
//   graph   → link / neighbors / traverse
//   rules   → registerRule / listRules / evaluateRules
//   context → context()
// Each section prints what it found so the run doubles as a living acceptance
// check: if the SDK regresses, the printed output (or a thrown error) changes.

import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import {
  createOntology,
  FilesystemAdapter,
  InMemoryAdapter,
  PostgresAdapter,
  type Ctx,
  type Instance,
  type Ontology,
  type Provenance,
} from '@dqa-ai-solutions/core-runtime'
import { entityTypes, relationshipTypes, rules } from './ontology.ts'

const ctx: Ctx = { tenantId: 'acme-audit', actor: 'auditor-1' }

// A consumer must attach provenance to every write — the SDK rejects writes
// without the full triple. We stamp it from the acting auditor.
function prov(sourceRef: string): Provenance {
  return {
    source_ref: sourceRef,
    confirmed_by: ctx.actor ?? 'system',
    confirmed_at: new Date().toISOString(),
  }
}

function heading(title: string): void {
  console.log(`\n${'─'.repeat(72)}\n▶ ${title}\n${'─'.repeat(72)}`)
}

// The Ontology façade keeps schema in an in-memory, per-tenant registry — it does
// NOT rehydrate type definitions from a persisted backend. So any Ontology that
// wants to read/write a tenant must declare the types first, even when the data
// already exists on disk. This helper makes that requirement explicit + reusable.
async function declareSchema(o: Ontology, c: Ctx): Promise<void> {
  for (const et of entityTypes) await o.defineEntityType(et, c)
  for (const rt of relationshipTypes) await o.defineRelationshipType(rt, c)
}

// ── Postgres helpers (§11 is opt-in — only runs if a DB is reachable) ─────────
// The project ships a docker Postgres on 5433; override with DATABASE_URL.
const PG_CONN = process.env.DATABASE_URL ?? 'postgres://ontology:ontology@localhost:5433/ontology'

async function pgReachable(conn: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: conn, connectionTimeoutMillis: 1500 })
  try {
    await client.connect()
    await client.query('SELECT 1')
    return true
  } catch {
    return false
  } finally {
    await client.end().catch(() => {})
  }
}

// PostgresAdapter isolates each tenant in its own schema named `t_<tenantId>`.
// We drop it before + after so the dogfood always runs against a clean slate.
async function dropPgSchema(conn: string, schema: string): Promise<void> {
  const client = new pg.Client({ connectionString: conn })
  try {
    await client.connect()
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
  } finally {
    await client.end().catch(() => {})
  }
}

async function main(): Promise<void> {
  const ontology = createOntology({ adapter: new InMemoryAdapter() })

  // ── 1. Define the schema and migrate it ───────────────────────────────────
  heading('1. Define schema + migrate')
  for (const et of entityTypes) await ontology.defineEntityType(et, ctx)
  for (const rt of relationshipTypes) await ontology.defineRelationshipType(rt, ctx)
  const migration = await ontology.migrate(ctx)
  console.log(`migrated at ${migration.appliedAt} — ${migration.changes.length} changes, ${migration.errors.length} errors`)
  const schema = await ontology.getSchema(ctx)
  console.log(`schema: ${schema.entityTypes.length} entity types, ${schema.relationshipTypes.length} relationship types`)

  // ── 2. Seed instances ─────────────────────────────────────────────────────
  heading('2. Create accounts, vouchers, evidence')
  const expense = await ontology.create('Account', { code: '642', name: 'Admin Expense' }, prov('coa#642'), ctx)
  const cash = await ontology.create('Account', { code: '111', name: 'Cash on Hand' }, prov('coa#111'), ctx)

  const v1 = await ontology.create('Voucher', { docNo: 'PC-001', amount: 5_000_000, issuedOn: '2026-03-01', status: 'posted' }, prov('scan/PC-001.pdf'), ctx)
  const v2 = await ontology.create('Voucher', { docNo: 'PC-002', amount: 20_000_000, issuedOn: '2026-03-02', status: 'posted' }, prov('scan/PC-002.pdf'), ctx)
  const v3 = await ontology.create('Voucher', { docNo: 'PC-003', amount: 3_000_000, issuedOn: '2026-03-03', status: 'posted' }, prov('scan/PC-003.pdf'), ctx)

  const e1 = await ontology.create('Evidence', { kind: 'invoice', ref: 'INV-9001' }, prov('scan/INV-9001.pdf'), ctx)
  const e2 = await ontology.create('Evidence', { kind: 'receipt', ref: 'RC-5501' }, prov('scan/RC-5501.pdf'), ctx)
  console.log(`created 2 accounts, 3 vouchers, 2 evidences`)
  console.log(`v1 provenance → ${v1.provenance.confirmed_by} @ ${v1.provenance.source_ref}`)

  // ── 3. Link the graph ──────────────────────────────────────────────────────
  heading('3. Link vouchers → accounts and → evidence')
  await ontology.link('posts_to', v1.id, expense.id, prov('journal/2026-03'), ctx)
  await ontology.link('posts_to', v2.id, expense.id, prov('journal/2026-03'), ctx)
  await ontology.link('posts_to', v3.id, cash.id, prov('journal/2026-03'), ctx)
  // v1 fully supported; v2 only one evidence (will trip the dual-evidence rule);
  // v3 deliberately left with NO evidence (will trip the required-evidence rule).
  await ontology.link('supported_by', v1.id, e1.id, prov('audit/match'), ctx)
  await ontology.link('supported_by', v1.id, e2.id, prov('audit/match'), ctx)
  await ontology.link('supported_by', v2.id, e1.id, prov('audit/match'), ctx)
  console.log('linked: v1→{e1,e2}, v2→{e1}, v3→{} ; all vouchers→accounts')

  // Demonstrate cardinality enforcement: posts_to is 1..N (one account per voucher).
  try {
    await ontology.link('posts_to', v1.id, cash.id, prov('journal/dup'), ctx)
    console.log('UNEXPECTED: second posts_to edge was allowed')
  } catch (err) {
    console.log(`cardinality guard works → ${(err as Error).message}`)
  }

  // ── 4. Update + read back ──────────────────────────────────────────────────
  heading('4. Update a voucher and read it back')
  await ontology.update(v3.id, { status: 'void' }, prov('audit/correction'), ctx)
  const reloaded = await ontology.get(v3.id, ctx)
  console.log(`v3 status is now "${reloaded?.data.status}"`)

  // ── 5. find() — three read modes ────────────────────────────────────────────
  // find() is the workhorse read. It has three distinct modes a consumer leans on.
  const docNos = (xs: Instance[]) => xs.map((i) => i.data.docNo).sort().join(', ')

  heading('5. find() — read-all / property filter / graph-aware')

  // (a) read every instance of a type — pass `undefined` for the where-clause.
  const allVouchers = await ontology.find('Voucher', undefined, ctx)
  console.log(`(a) all vouchers          → ${docNos(allVouchers)}`)

  // (b) property filter — amount > 4,000,000.
  const big = await ontology.find(
    'Voucher',
    { op: 'compare', left: { kind: 'property', entity: 'Voucher', name: 'amount' }, cmp: '>', right: { kind: 'literal', value: 4_000_000 } },
    ctx,
  )
  console.log(`(b) amount > 4,000,000    → ${big.map((i) => `${i.data.docNo}=${i.data.amount}`).join(', ')}`)

  // (c) graph-aware filter — relationship ops (absent/exists/count) make find()
  // resolve edges per instance, so you can query the GRAPH, not just properties.
  const unsupported = await ontology.find('Voucher', { op: 'absent', relationship: 'supported_by' }, ctx)
  const dualBacked = await ontology.find('Voucher', { op: 'count', relationship: 'supported_by', cmp: '>=', n: 2 }, ctx)
  console.log(`(c) no evidence           → ${docNos(unsupported)}`)
  console.log(`(c) >= 2 evidences        → ${docNos(dualBacked)}`)

  // Expected: all={PC-001,PC-002,PC-003}; unsupported={PC-003}; dualBacked={PC-001}.
  const readsOk =
    allVouchers.length === 3 &&
    docNos(unsupported) === 'PC-003' &&
    docNos(dualBacked) === 'PC-001'

  // ── 6. neighbors + traverse ─────────────────────────────────────────────────
  heading('6. neighbors(v1) and traverse(v1 → posts_to)')
  const nbrs = await ontology.neighbors(v1.id, undefined, ctx)
  console.log(`v1 neighbours: ${nbrs.map((n: Instance) => n.data.docNo ?? n.data.ref ?? n.data.code).join(', ')}`)
  const path = await ontology.traverse({ start: v1.id, path: ['posts_to'], direction: 'forward' }, ctx)
  console.log(`traverse reached ${path.nodes.length} nodes via ${path.edges.length} edge(s); end account = ${path.nodes.at(-1)?.data.code}`)

  // ── 7. Register rules + evaluate ────────────────────────────────────────────
  heading('7. Register audit rules and evaluate')
  for (const rule of rules) await ontology.registerRule(rule, ctx)
  const registered = await ontology.listRules({ enabled: true }, ctx)
  console.log(`registered ${registered.length} rules: ${registered.map((r) => r.id).join(', ')}`)

  const flags = await ontology.evaluateRules({ tenantId: ctx.tenantId, entityType: 'Voucher' })
  console.log(`\nevaluateRules raised ${flags.length} flag(s):`)
  for (const f of flags) {
    console.log(`  [${f.severityLabel}] ${f.ruleId} on ${f.target} → ${f.message}`)
  }

  // ── 8. context() retrieval around an instance ──────────────────────────────
  heading('8. context() around v2')
  const bundle = await ontology.context({ query: 'why is PC-002 flagged?', around: v2.id }, ctx)
  console.log(`structured: ${bundle.structured.instances.length} instances, ${bundle.structured.edges.length} edges, ${bundle.structured.rules.length} rules`)
  console.log(`documents: ${bundle.documents.length} (no vector adapter wired → expected 0)`)

  // ── 9. Input validation (negative cases) ───────────────────────────────────
  // A consumer relies on the SDK rejecting bad input BEFORE it reaches storage.
  // Each probe must throw the expected ontology error code; a silent accept is a
  // regression. `ontologyError` prefixes its message with "[CODE] ...".
  heading('9. Input validation — every bad write must be rejected')
  const probes: Array<{ label: string; code: string; run: () => Promise<unknown> }> = [
    { label: 'node: unknown property', code: 'UNKNOWN_PROPERTY',
      run: () => ontology.create('Voucher', { docNo: 'X', amount: 1, issuedOn: '2026-03-01', status: 'posted', foo: 1 }, prov('bad'), ctx) },
    { label: 'node: type mismatch (amount as string)', code: 'TYPE_MISMATCH',
      run: () => ontology.create('Voucher', { docNo: 'X', amount: 'lots', issuedOn: '2026-03-01', status: 'posted' }, prov('bad'), ctx) },
    { label: 'node: invalid enum value', code: 'ENUM_VALUE_INVALID',
      run: () => ontology.create('Voucher', { docNo: 'X', amount: 1, issuedOn: '2026-03-01', status: 'archived' }, prov('bad'), ctx) },
    { label: 'node: missing required property', code: 'REQUIRED_PROPERTY_MISSING',
      run: () => ontology.create('Voucher', { docNo: 'X', issuedOn: '2026-03-01', status: 'posted' }, prov('bad'), ctx) },
    { label: 'node: re-declared provenance field', code: 'PROVENANCE_FIELD_REDECLARED',
      run: () => ontology.create('Voucher', { docNo: 'X', amount: 1, issuedOn: '2026-03-01', status: 'posted', source_ref: 'spoof' }, prov('bad'), ctx) },
    { label: 'node: unknown entity type', code: 'UNKNOWN_ENTITY_TYPE',
      run: () => ontology.create('Ghost', { x: 1 }, prov('bad'), ctx) },
    { label: 'write: missing provenance', code: 'PROVENANCE_MISSING',
      run: () => ontology.create('Voucher', { docNo: 'X', amount: 1, issuedOn: '2026-03-01', status: 'posted' }, { source_ref: '', confirmed_by: '', confirmed_at: '' }, ctx) },
    { label: 'edge: endpoint type mismatch (Account as from)', code: 'ENDPOINT_TYPE_MISMATCH',
      run: () => ontology.link('posts_to', expense.id, v1.id, prov('bad'), ctx) },
    { label: 'edge: endpoint instance not found', code: 'INSTANCE_NOT_FOUND',
      run: () => ontology.link('posts_to', v1.id, 'no-such-id', prov('bad'), ctx) },
    { label: 'edge: unknown relationship type', code: 'UNKNOWN_RELATIONSHIP_TYPE',
      run: () => ontology.link('ghost_rel', v1.id, expense.id, prov('bad'), ctx) },
  ]
  let rejected = 0
  for (const p of probes) {
    try {
      await p.run()
      console.log(`  ✗ NOT REJECTED — ${p.label} (expected ${p.code})`)
    } catch (err) {
      const msg = (err as Error).message
      const hit = msg.includes(`[${p.code}]`)
      if (hit) rejected += 1
      console.log(`  ${hit ? '✓' : '✗'} ${p.label} → ${msg}`)
    }
  }
  const allRejected = rejected === probes.length
  console.log(`rejected ${rejected}/${probes.length} bad writes`)

  // ── 10. Backend parity + durability (FilesystemAdapter) ─────────────────────
  // The SDK's headline claim is backend-agnosticism (QG-5 parity): the same code
  // behaves identically on every adapter. Here we persist with one Ontology over
  // a FilesystemAdapter, then read it back through a SEPARATE Ontology pointed at
  // the same directory — proving the data is genuinely durable on disk, not just
  // in process memory, and that graph-aware reads + rules survive a round-trip.
  heading('10. FilesystemAdapter — durability + parity')
  const dir = mkdtempSync(join(tmpdir(), 'dqa-dogfood-'))
  let fsOk = false
  try {
    // writer
    const writer = createOntology({ adapter: new FilesystemAdapter(dir) })
    await declareSchema(writer, ctx)
    await writer.migrate(ctx)
    const fAcct = await writer.create('Account', { code: '642', name: 'Admin Expense' }, prov('fs/acct'), ctx)
    const fv1 = await writer.create('Voucher', { docNo: 'FS-001', amount: 5_000_000, issuedOn: '2026-04-01', status: 'posted' }, prov('fs/1'), ctx)
    const fv2 = await writer.create('Voucher', { docNo: 'FS-002', amount: 3_000_000, issuedOn: '2026-04-02', status: 'posted' }, prov('fs/2'), ctx)
    const fe1 = await writer.create('Evidence', { kind: 'invoice', ref: 'INV-FS' }, prov('fs/e1'), ctx)
    // Mirror the in-memory scenario: both vouchers posted; only FS-002 left unsupported.
    await writer.link('posts_to', fv1.id, fAcct.id, prov('fs/post'), ctx)
    await writer.link('posts_to', fv2.id, fAcct.id, prov('fs/post'), ctx)
    await writer.link('supported_by', fv1.id, fe1.id, prov('fs/match'), ctx)
    for (const rule of rules) await writer.registerRule(rule, ctx)
    const fileCount = readdirSync(join(dir, ctx.tenantId), { recursive: true }).filter((f) => String(f).endsWith('.json')).length
    console.log(`persisted ${fileCount} JSON files under ${ctx.tenantId}/ (instances, edges, rules, _schema)`)

    // reader — a fresh Ontology over the SAME dir; must redeclare schema (see declareSchema note)
    const reader = createOntology({ adapter: new FilesystemAdapter(dir) })
    await declareSchema(reader, ctx)
    const reloaded = await reader.get(fv1.id, ctx)
    const all = await reader.find('Voucher', undefined, ctx)
    const unsupported = await reader.find('Voucher', { op: 'absent', relationship: 'supported_by' }, ctx)
    const fsFlags = await reader.evaluateRules({ tenantId: ctx.tenantId, entityType: 'Voucher' })
    const unsupportedDocs = unsupported.map((i) => i.data.docNo).join(',')
    console.log(`read back via fresh Ontology → get(FS-001)="${reloaded?.data.docNo}", find-all=${all.length}, no-evidence={${unsupportedDocs}}`)
    console.log(`rules survived round-trip   → ${fsFlags.map((f) => f.ruleId).join(', ')}`)

    // Parity assertion: FS-002 (no evidence) must be the only unsupported voucher,
    // exactly as the in-memory backend reported for its PC-003.
    fsOk =
      reloaded?.data.docNo === 'FS-001' &&
      all.length === 2 &&
      unsupportedDocs === 'FS-002' &&
      fsFlags.some((f) => f.ruleId === 'R-EVIDENCE-REQUIRED' && f.target === fv2.id)
    console.log(`parity with in-memory backend: ${fsOk ? 'OK' : 'MISMATCH'}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // ── 11. Postgres parity (opt-in — needs a reachable Postgres) ───────────────
  // Same scenario, same code — now over a real SQL backend with schema-per-tenant
  // isolation. Proves backend-agnosticism reaches all the way to Postgres, and
  // that cardinality is enforced above the adapter (so the DB stays consistent).
  // Skips cleanly when no DB is reachable, so the example runs anywhere.
  heading('11. PostgresAdapter — parity (opt-in)')
  const pgCtx: Ctx = { tenantId: 'dogfood_pg', actor: 'auditor-1' }
  const pgSchema = 't_dogfood_pg'
  let pgStatus: 'OK' | 'MISMATCH' | 'skipped' = 'skipped'
  if (!(await pgReachable(PG_CONN))) {
    console.log(`skipped — no reachable Postgres at ${PG_CONN}`)
    console.log('         (start the project DB or set DATABASE_URL to enable this section)')
  } else {
    await dropPgSchema(PG_CONN, pgSchema) // clean slate in case a prior run crashed
    try {
      const writer = createOntology({ adapter: new PostgresAdapter({ connectionString: PG_CONN }) })
      await declareSchema(writer, pgCtx)
      const mig = await writer.migrate(pgCtx)
      console.log(`migrate → ${mig.changes.length} changes, ${mig.errors.length} errors (schema-per-tenant)`)
      const pAcct = await writer.create('Account', { code: '642', name: 'Admin Expense' }, prov('pg/acct'), pgCtx)
      const pAcct2 = await writer.create('Account', { code: '111', name: 'Cash' }, prov('pg/acct2'), pgCtx)
      const pv1 = await writer.create('Voucher', { docNo: 'PG-001', amount: 5_000_000, issuedOn: '2026-05-01', status: 'posted' }, prov('pg/1'), pgCtx)
      const pv2 = await writer.create('Voucher', { docNo: 'PG-002', amount: 3_000_000, issuedOn: '2026-05-02', status: 'posted' }, prov('pg/2'), pgCtx)
      const pe1 = await writer.create('Evidence', { kind: 'invoice', ref: 'INV-PG' }, prov('pg/e1'), pgCtx)
      await writer.link('posts_to', pv1.id, pAcct.id, prov('pg/post'), pgCtx)
      await writer.link('posts_to', pv2.id, pAcct.id, prov('pg/post'), pgCtx)
      await writer.link('supported_by', pv1.id, pe1.id, prov('pg/match'), pgCtx)
      for (const rule of rules) await writer.registerRule(rule, pgCtx)

      // Cardinality enforced against a real DB: posting v1 to a 2nd account must fail.
      let cardinalityEnforced = false
      try {
        await writer.link('posts_to', pv1.id, pAcct2.id, prov('pg/dup'), pgCtx)
      } catch (err) {
        cardinalityEnforced = (err as Error).message.includes('[CARDINALITY_VIOLATION]')
      }

      // Reader: a fresh Ontology + new pool against the same DB.
      const reader = createOntology({ adapter: new PostgresAdapter({ connectionString: PG_CONN }) })
      await declareSchema(reader, pgCtx)
      const got = await reader.get(pv1.id, pgCtx)
      const all = await reader.find('Voucher', undefined, pgCtx)
      const unsupported = await reader.find('Voucher', { op: 'absent', relationship: 'supported_by' }, pgCtx)
      const trav = await reader.traverse({ start: pv1.id, path: ['posts_to'], direction: 'forward' }, pgCtx)
      const pgFlags = await reader.evaluateRules({ tenantId: pgCtx.tenantId, entityType: 'Voucher' })
      const unsupportedDocs = unsupported.map((i) => i.data.docNo).join(',')
      console.log(`read back via fresh Ontology → get(PG-001)="${got?.data.docNo}", find-all=${all.length}, no-evidence={${unsupportedDocs}}`)
      console.log(`traverse posts_to → ${trav.nodes.length} nodes, end account=${trav.nodes.at(-1)?.data.code}; rules → ${pgFlags.map((f) => f.ruleId).join(', ')}`)
      console.log(`cardinality enforced at DB: ${cardinalityEnforced}`)

      const matches =
        got?.data.docNo === 'PG-001' &&
        all.length === 2 &&
        unsupportedDocs === 'PG-002' &&
        cardinalityEnforced &&
        pgFlags.some((f) => f.ruleId === 'R-EVIDENCE-REQUIRED' && f.target === pv2.id)
      pgStatus = matches ? 'OK' : 'MISMATCH'
      console.log(`parity with in-memory + filesystem backends: ${pgStatus}`)
    } finally {
      await dropPgSchema(PG_CONN, pgSchema)
      console.log(`(cleaned up schema ${pgSchema})`)
    }
  }

  // ── Summary / assertion ────────────────────────────────────────────────────
  heading('Summary')
  const byRule = new Map<string, number>()
  for (const f of flags) byRule.set(f.ruleId, (byRule.get(f.ruleId) ?? 0) + 1)
  // Expected: v3 trips R-EVIDENCE-REQUIRED; v2 trips R-HIGHVALUE-DUAL-EVIDENCE.
  const rulesOk = byRule.get('R-EVIDENCE-REQUIRED') === 1 && byRule.get('R-HIGHVALUE-DUAL-EVIDENCE') === 1
  console.log(`flags by rule: ${JSON.stringify(Object.fromEntries(byRule))}`)
  console.log(`reads: find-all/property/graph-aware ${readsOk ? 'OK' : 'MISMATCH'}`)
  console.log(`validation: ${rejected}/${probes.length} bad writes rejected`)
  console.log(`filesystem parity + durability: ${fsOk ? 'OK' : 'MISMATCH'}`)
  console.log(`postgres parity: ${pgStatus}`)
  if (!rulesOk || !readsOk || !allRejected || !fsOk || pgStatus === 'MISMATCH') {
    console.error('✗ DOGFOOD ASSERTION FAILED — ' +
      (!readsOk ? 'find() reads did not match expectations'
        : !rulesOk ? 'rule evaluation did not match expectations'
        : !allRejected ? 'a bad write was not rejected'
        : !fsOk ? 'filesystem backend did not match in-memory behavior'
        : 'postgres backend did not match in-memory behavior'))
    process.exitCode = 1
    return
  }
  const pgNote = pgStatus === 'OK' ? 'in-memory + filesystem + postgres' : 'in-memory + filesystem (postgres skipped)'
  console.log(`✓ dogfood run passed — SDK behaved as expected across all capabilities (${pgNote})`)
}

main().catch((err) => {
  console.error('✗ dogfood run threw:', err)
  process.exitCode = 1
})
