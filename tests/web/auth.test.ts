import { normalizeEmail, normalizePhone, safeEqual } from '../../src/web/auth.js'

describe('passwordless web authentication helpers', () => {
  test('normalizes an international phone number to E.164', () => {
    expect(normalizePhone('+234 (801) 234-5678')).toBe('+2348012345678')
  })

  test('rejects local, short, and malformed phone numbers', () => {
    expect(normalizePhone('08012345678')).toBeNull()
    expect(normalizePhone('+123')).toBeNull()
    expect(normalizePhone('+234-hello')).toBeNull()
  })

  test('compares verification hashes without accepting different lengths', () => {
    expect(safeEqual('same', 'same')).toBe(true)
    expect(safeEqual('same', 'different')).toBe(false)
    expect(safeEqual('same', 'sam')).toBe(false)
  })

  test('normalizes and validates email addresses', () => {
    expect(normalizeEmail('  Person@Example.COM ')).toBe('person@example.com')
    expect(normalizeEmail('not-an-email')).toBeNull()
    expect(normalizeEmail('person..name@example.com')).toBeNull()
  })
})
