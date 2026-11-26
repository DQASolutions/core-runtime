/**
 * PropertyType `file` — a reference to a stored file (scan, photo, attachment).
 *
 * WHY THIS TYPE EXISTS
 *
 *   A scanned decision used to be declared `type: 'text'`, and "this field must
 *   hold a real scan" lived in the *caller's* workflow layer, restated once per
 *   step. Restating a fact is how it drifts: in one real domain the same idea
 *   was spelled two ways across eight steps, and a ninth step forgot it.
 *
 *   The fact belongs to the DATA, not to the step. `file` says it once.
 *
 * WHAT THIS TYPE DELIBERATELY DOES NOT DO
 *
 *   It does not prove the bytes exist. The SDK owns no file store and has no
 *   port for one — asserting existence here would be asserting something the
 *   SDK cannot see. It validates the *shape*: a non-empty path. Whoever owns
 *   the store proves the rest.
 */

import { describe, it, expect } from 'vitest'
import { SchemaRegistry } from '../../../src/core/schema/schema-registry.js'
import { collectInstanceDataErrors } from '../../../src/core/graph/validation.js'
import type { EntityTypeDef } from '../../../src/types/index.js'

const DECISION: EntityTypeDef = {
  name: 'SignedDecision',
  label: 'Quyết định đã ký',
  properties: [
    { name: 'decisionNumber', type: 'text', required: true },
    { name: 'scanPath', type: 'file', required: true },
  ],
}

describe('PropertyType: file', () => {
  it('is accepted as a property type', () => {
    const reg = new SchemaRegistry()
    expect(() => reg.defineEntityType(DECISION)).not.toThrow()
  })

  it('accepts a path', () => {
    const errs = collectInstanceDataErrors(DECISION,
      { decisionNumber: '12/QĐ', scanPath: 'scans/2026/12-qd.png' }, { partial: false })
    expect(errs).toEqual([])
  })

  it('rejects a non-string — a file reference is a path, not a number or an object', () => {
    const errs = collectInstanceDataErrors(DECISION, { decisionNumber: '12/QĐ', scanPath: 42 }, { partial: false })
    expect(errs.length).toBeGreaterThan(0)
  })

  /**
   * The case that motivates the whole type: an empty string satisfies
   * `type: 'text'` + `required: true` — the field is "present" while the
   * evidence is missing. A missing file dressed up as a present one.
   */
  it('rejects an empty path — a blank is a missing file wearing a present one\'s clothes', () => {
    const errs = collectInstanceDataErrors(DECISION, { decisionNumber: '12/QĐ', scanPath: '   ' }, { partial: false })
    expect(errs.length).toBeGreaterThan(0)
  })

  it('still reports a genuinely absent required file', () => {
    const errs = collectInstanceDataErrors(DECISION, { decisionNumber: '12/QĐ' }, { partial: false })
    expect(errs.length).toBeGreaterThan(0)
  })
})
