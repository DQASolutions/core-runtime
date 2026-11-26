/**
 * Three ways a declaration looked right and constrained nothing — measured on
 * the reference app 12–13/9/2026 — and the checks that now refuse them.
 *
 *   ① A `pattern` valid for the server (flag `u`) and broken for the browser
 *     (flag `v`): the browser drops the whole rule without a word.
 *   ② A `file` property with no word on kinds or size: the store keeps a path,
 *     so no write guard ever saw the 400 MB video.
 *   ③ A value that is not written to an entity (a step parameter) had no way to
 *     be checked by the same rule a property is.
 */
import { describe, it, expect } from 'vitest'
import {
  constraintDeclarationError, checkPropertyValue, fileViolation, resolveValueTypes,
  type PropertyDef, type EntityTypeDef, type ValueTypeDef,
} from '../../../src/index.js'
import * as input from '../../../src/input/index.js'

const why = (p: Partial<PropertyDef>) => constraintDeclarationError({ name: 'x', type: 'text', ...p } as PropertyDef)

describe('① pattern must compile for the browser too (flag v)', () => {
  it.each([
    ['^[0-9]+[/-][^@#]+$', 'unescaped / and - in a class'],
    ['^[0-9+() .-]{3,20}$', 'unescaped ( ) - in a class'],
    ['^[a|b]$', 'unescaped | in a class'],
  ])('REFUSE %s — %s', (pattern) => {
    expect(why({ pattern })).toMatch(/does not compile in the browser \(flag v\)/)
  })
  it.each([
    '^[0-9]+[\\/\\-][^@#]+$',
    '^[0-9+\\(\\) .\\-]{3,20}$',
    '^[0-9]{12}$',
  ])('ACCEPT %s — escaped, and still matches what it must', (pattern) => {
    expect(why({ pattern })).toBeNull()
  })
  it('a pattern broken for both flags still says so plainly', () => {
    expect(why({ pattern: '([' })).toMatch(/^"pattern" does not compile:/)
  })
})

describe('② file: accept + maxBytes are declared, and checked for sense', () => {
  const file = (p: Partial<PropertyDef>) => constraintDeclarationError({ name: 'scan', type: 'file', ...p } as PropertyDef)
  it.each([
    [{ accept: [] }, /non-empty list/],
    [{ accept: 'application/pdf' as unknown as string[] }, /non-empty list/],
    [{ accept: ['pdf'] }, /"pdf" is not a MIME type/],
    [{ accept: ['image/'] }, /is not a MIME type/],
    [{ maxBytes: 0 }, /above 0/],
    [{ maxBytes: -1 }, /above 0/],
    [{ maxBytes: 1.5 }, /whole number/],
    [{ maxBytes: '10MB' as unknown as number }, /whole number/],
  ])('REFUSE %j', (p, msg) => {
    expect(file(p)).toMatch(msg)
  })
  it('REFUSE accept/maxBytes on a type that holds no file', () => {
    expect(why({ accept: ['.pdf'] })).toMatch(/"accept" does not apply to type "text"/)
    expect(constraintDeclarationError({ name: 'n', type: 'number', maxBytes: 10 } as PropertyDef)).toMatch(/does not apply/)
  })
  it('ACCEPT the three spellings', () => {
    expect(file({ accept: ['application/pdf', 'image/*', '.docx'], maxBytes: 10 * 1024 * 1024 })).toBeNull()
  })
  it('a value type carries them to every property that names it', () => {
    const vt: ValueTypeDef[] = [{ name: 'signedScan', type: 'file', accept: ['application/pdf', 'image/*'], maxBytes: 20_000_000 }]
    const et: EntityTypeDef = { name: 'Decision', label: 'x', properties: [{ name: 'scanPath', type: 'file', valueType: 'signedScan' }] }
    const [d] = resolveValueTypes([et], vt)
    expect(d!.properties[0]).toMatchObject({ accept: ['application/pdf', 'image/*'], maxBytes: 20_000_000 })
  })
})

describe('② fileViolation — the one rule the element and the upload endpoint share', () => {
  const def = { name: 'scan', type: 'file', accept: ['application/pdf', 'image/*', '.docx'], maxBytes: 1000 } as PropertyDef
  it.each([
    [{ name: 'a.pdf', type: 'application/pdf', size: 1001 }, 'maxBytes'],
    [{ name: 'movie.mp4', type: 'video/mp4', size: 10 }, 'accept'],
    [{ name: 'a.exe', type: '', size: 10 }, 'accept'],
    // A spoofed extension does not buy a MIME type the list does not name.
    [{ name: 'a.pdf', type: 'text/html', size: 10 }, 'accept'],
    // No MIME type and no listed extension: not waved through for lacking one.
    [{ name: 'scan', size: 10 }, 'accept'],
  ])('REFUSE %j → %s', (f, keyword) => {
    expect(fileViolation(def, f)).toMatchObject({ code: 'CONSTRAINT_VIOLATED', keyword })
  })
  it.each([
    { name: 'a.pdf', type: 'application/pdf', size: 1000 },
    { name: 'photo.JPG', type: 'image/jpeg', size: 10 },
    // Dropped from a system that sends no MIME type — judged by its extension.
    { name: 'Report.DOCX', type: '', size: 10 },
  ])('ACCEPT %j', (f) => {
    expect(fileViolation(def, f)).toBeNull()
  })
  it('nothing declared, nothing refused — the declaration is where the rule lives', () => {
    expect(fileViolation({ name: 'f', type: 'file' }, { name: 'x.exe', size: 1e9 })).toBeNull()
  })
})

describe('③ checkPropertyValue — the write guard\'s verdict for a value that is not being written', () => {
  const money = { name: 'amount', type: 'number', minimum: 0, maximum: 1e13, multipleOf: 1 } as PropertyDef
  it('REFUSE with the same code and keyword the write guard uses', () => {
    expect(checkPropertyValue(money, 12.5)).toMatchObject({ code: 'CONSTRAINT_VIOLATED', keyword: 'multipleOf' })
    expect(checkPropertyValue(money, -1)).toMatchObject({ keyword: 'minimum' })
    expect(checkPropertyValue(money, '12')).toMatchObject({ code: 'TYPE_MISMATCH' })
    expect(checkPropertyValue({ name: 'n', type: 'text', maxLength: 3 } as PropertyDef, 'abcd')).toMatchObject({ keyword: 'maxLength' })
    expect(checkPropertyValue({ name: 'd', type: 'date' } as PropertyDef, '12/09/2026')).toMatchObject({ code: 'TYPE_MISMATCH' })
  })
  it('absent is not wrong — whether it may be absent is `required`, asked elsewhere', () => {
    expect(checkPropertyValue(money, undefined)).toBeNull()
    expect(checkPropertyValue(money, null)).toBeNull()
  })
  it('reachable from the browser-safe entry too', () => {
    expect(input.checkPropertyValue).toBe(checkPropertyValue)
    expect(input.fileViolation).toBe(fileViolation)
  })
})
