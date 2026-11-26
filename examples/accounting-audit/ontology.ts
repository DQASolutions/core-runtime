// Dogfood example — the accounting-audit ontology, expressed purely as DATA.
//
// This file declares WHAT the domain is (entity types, relationship types,
// audit rules) without any SDK wiring. main.ts loads it through the public
// `@dqa-ai-solutions/ontology-sdk` surface. Rules are data, never code (NT4) — note that a
// rule's `condition` describes the VIOLATION: when it evaluates true for an
// instance, evaluateRules() raises a Flag.

import type {
  EntityTypeDef,
  RelationshipTypeDef,
  RuleDef,
} from '@dqa-ai-solutions/core-runtime'

// ── Entity types ────────────────────────────────────────────────────────────
// The SDK injects provenance (id / source_ref / confirmed_by / confirmed_at)
// into every type automatically — never declare those fields here.

export const entityTypes: EntityTypeDef[] = [
  {
    name: 'Account',
    label: 'Ledger Account',
    properties: [
      { name: 'code', type: 'text', required: true, description: 'Chart-of-accounts code, e.g. "642"' },
      { name: 'name', type: 'text', required: true },
    ],
  },
  {
    name: 'Voucher',
    label: 'Accounting Voucher',
    properties: [
      { name: 'docNo', type: 'text', required: true, description: 'Human voucher number, e.g. "PC-001"' },
      { name: 'amount', type: 'number', required: true, description: 'Posted amount in VND' },
      { name: 'issuedOn', type: 'date', required: true },
      {
        name: 'status',
        type: 'enum',
        enumValues: ['draft', 'posted', 'void'],
        required: true,
      },
    ],
  },
  {
    name: 'Evidence',
    label: 'Supporting Evidence',
    properties: [
      {
        name: 'kind',
        type: 'enum',
        enumValues: ['invoice', 'receipt', 'contract'],
        required: true,
      },
      { name: 'ref', type: 'text', required: true, description: 'External document reference' },
    ],
  },
]

// ── Relationship types ──────────────────────────────────────────────────────
// Rule relationship-ops (exists/absent/count) evaluate OUTGOING edges from the
// instance under test, so the rule subject is always the `from` side. Both
// relationships below originate at Voucher for exactly that reason.

export const relationshipTypes: RelationshipTypeDef[] = [
  {
    name: 'posts_to',
    from: 'Voucher',
    to: 'Account',
    cardinality: '1..N', // each voucher posts to one account; an account has many vouchers
    directed: true,
    description: 'Voucher is posted against a ledger account',
  },
  {
    name: 'supported_by',
    from: 'Voucher',
    to: 'Evidence',
    cardinality: 'N..N', // a voucher may cite many evidences; evidence may back many vouchers
    directed: true,
    description: 'Voucher is substantiated by a piece of evidence',
  },
]

// ── Audit rules (data) ──────────────────────────────────────────────────────

function ruleProv() {
  return {
    source_ref: 'audit-policy/v2026.1',
    confirmed_by: 'chief-auditor',
    confirmed_at: '2026-01-15T00:00:00.000Z',
  }
}

export const rules: RuleDef[] = [
  {
    id: 'R-EVIDENCE-REQUIRED',
    name: 'Every voucher must be supported by evidence',
    kind: 'REQUIRED_RELATION',
    appliesTo: 'Voucher',
    // VIOLATION: no supported_by edge at all.
    condition: { op: 'absent', relationship: 'supported_by' },
    severity: 'PHAP_LY',
    message: 'Voucher {docNo} ({id}) has no supporting evidence',
    enabled: true,
    version: 1,
    ...ruleProv(),
  },
  {
    id: 'R-VOUCHER-MUST-POST',
    name: 'Every voucher must post to an account',
    kind: 'REQUIRED_RELATION',
    appliesTo: 'Voucher',
    condition: { op: 'absent', relationship: 'posts_to' },
    severity: 'PHAP_LY',
    message: 'Voucher {docNo} is not posted to any ledger account',
    enabled: true,
    version: 1,
    ...ruleProv(),
  },
  {
    id: 'R-HIGHVALUE-DUAL-EVIDENCE',
    name: 'High-value vouchers need at least two evidences',
    kind: 'REQUIRED_RELATION',
    appliesTo: 'Voucher',
    // VIOLATION: amount >= 10,000,000 AND fewer than 2 supporting evidences.
    condition: {
      op: 'and',
      clauses: [
        {
          op: 'compare',
          left: { kind: 'property', entity: 'Voucher', name: 'amount' },
          cmp: '>=',
          right: { kind: 'literal', value: 10_000_000 },
        },
        { op: 'count', relationship: 'supported_by', cmp: '<', n: 2 },
      ],
    },
    severity: 'CANH_BAO',
    message: 'High-value voucher {docNo} (amount {amount}) has fewer than 2 evidences',
    enabled: true,
    version: 1,
    ...ruleProv(),
  },
]
