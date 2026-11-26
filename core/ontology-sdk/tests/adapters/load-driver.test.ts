import { describe, expect, it } from 'vitest'

import { loadDriver } from '../../src/adapters/load-driver.js'
import { OntologyError } from '../../src/types/index.js'

describe('loadDriver', () => {
  it('loads an installed driver', () => {
    expect(loadDriver<{ Pool: unknown }>('pg', 'PostgresAdapter').Pool).toBeTypeOf('function')
  })

  it('names the missing package and the adapter that needs it', () => {
    let err: unknown
    try {
      loadDriver('@dqa/no-such-driver', 'SomeAdapter')
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(OntologyError)
    expect((err as OntologyError).code).toBe('ADAPTER_DRIVER_MISSING')
    expect((err as OntologyError).message).toContain('SomeAdapter needs the "@dqa/no-such-driver" package')
  })
})
