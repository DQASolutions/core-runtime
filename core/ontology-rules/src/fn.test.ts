import { describe, it, expect } from 'vitest'
import { compute, rule, action, isFnSpec, collectSpecs } from './fn.js'

describe('fn authoring helpers', () => {
  it('compute returns a tagged ComputeSpec', () => {
    const spec = compute('reconDelta', async () => 42)
    expect(spec.kind).toBe('compute')
    expect(spec.name).toBe('reconDelta')
    expect(isFnSpec(spec)).toBe(true)
  })

  it('action returns a tagged ActionSpec with name + effect', () => {
    const spec = action('emitCoDo', { effect: () => [{ type: 'codo.created', aggregate: 'g1' }] })
    expect(spec.kind).toBe('action')
    expect(spec.name).toBe('emitCoDo')
    expect(isFnSpec(spec)).toBe(true)
  })

  it('rule with `khi` (per-instance) is tagged and carries its type', () => {
    const spec = rule({ on: 'GiaoDich', id: 'R-XANG-THIEU-LOG', severity: 'cao', khi: (g) => g.data.category === 'xăng' })
    expect(spec.kind).toBe('rule')
    expect(spec.on).toBe('GiaoDich')
    expect(spec.khi).toBeTypeOf('function')
  })

  it('rule with `timViPham` (collection) is allowed', () => {
    const spec = rule({ on: 'KyKeToan', id: 'R-CHIA-NHO', timViPham: () => [] })
    expect(spec.timViPham).toBeTypeOf('function')
  })

  it('rule requires either `khi` or `timViPham`', () => {
    expect(() => rule({ on: 'GiaoDich', id: 'R-X' })).toThrow(/khi.*timViPham/)
  })

  it('isFnSpec rejects non-specs', () => {
    expect(isFnSpec(null)).toBe(false)
    expect(isFnSpec({ kind: 'nope' })).toBe(false)
    expect(isFnSpec(42)).toBe(false)
  })

  it('collectSpecs groups module exports by kind, rules by type', () => {
    const moduleExports = {
      reconDelta: compute('reconDelta', () => 0),
      r1: rule({ on: 'GiaoDich', id: 'R-A', khi: () => true }),
      r2: rule({ on: 'GiaoDich', id: 'R-B', khi: () => true }),
      r3: rule({ on: 'KyKeToan', id: 'R-C', timViPham: () => [] }),
      emitCoDo: action('emitCoDo', { effect: () => [] }),
      // exported array of specs is also collected
      extra: [compute('x', () => 1), rule({ on: 'KyKeToan', id: 'R-D', khi: () => true })],
      // non-specs are ignored
      helper: () => 'ignored',
      n: 7,
    }
    const c = collectSpecs(moduleExports)
    expect(c.computes.map((s) => s.name).sort()).toEqual(['reconDelta', 'x'])
    expect(c.actions.map((s) => s.name)).toEqual(['emitCoDo'])
    expect(c.rulesByType['GiaoDich'].map((s) => s.id).sort()).toEqual(['R-A', 'R-B'])
    expect(c.rulesByType['KyKeToan'].map((s) => s.id).sort()).toEqual(['R-C', 'R-D'])
  })

  it('collectSpecs merges into an existing accumulator', () => {
    const acc = collectSpecs({ a: compute('a', () => 1) })
    collectSpecs({ b: compute('b', () => 2) }, acc)
    expect(acc.computes.map((s) => s.name).sort()).toEqual(['a', 'b'])
  })
})
