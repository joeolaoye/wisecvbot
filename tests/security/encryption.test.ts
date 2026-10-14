import { decryptCv, encryptCv } from '../../src/security/encryption.js'

describe('CV envelope encryption (AES-256-GCM)', () => {
  test('roundtrips the plaintext exactly', () => {
    const cv = Buffer.from('Jane Doe — Senior Backend Engineer. jane@example.com +1 555 0100')
    const blob = encryptCv(cv)
    expect(blob.equals(cv)).toBe(false)
    expect(decryptCv(blob).toString()).toBe(cv.toString())
  })

  test('every encryption uses a fresh IV', () => {
    const cv = Buffer.from('same plaintext')
    expect(encryptCv(cv).equals(encryptCv(cv))).toBe(false)
  })

  test('tampered ciphertext fails authentication instead of decrypting garbage', () => {
    const blob = encryptCv(Buffer.from('secret cv'))
    const last = blob.length - 1
    blob.writeUInt8(blob.readUInt8(last) ^ 0xff, last)
    expect(() => decryptCv(blob)).toThrow()
  })
})
