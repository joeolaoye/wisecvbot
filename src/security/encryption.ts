import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { env } from '../config/env.js'

/**
 * Envelope encryption for CV blobs: AES-256-GCM with a per-blob IV.
 * Layout: [12-byte IV][16-byte auth tag][ciphertext]. The key lives in the
 * environment (never in the database, never in the repo).
 */
function key(): Buffer {
  return Buffer.from(env.CV_ENCRYPTION_KEY, 'base64')
}

export function encryptCv(plaintext: Buffer): Buffer {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ciphertext])
}

export function decryptCv(blob: Buffer): Buffer {
  const iv = blob.subarray(0, 12)
  const tag = blob.subarray(12, 28)
  const ciphertext = blob.subarray(28)
  const decipher = createDecipheriv('aes-256-gcm', key(), iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ciphertext), decipher.final()])
}
