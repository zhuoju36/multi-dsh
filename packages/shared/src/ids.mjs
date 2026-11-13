/** Identifier and hashing helpers. Opaque IDs never carry PII. */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567'

/**
 * Encode bytes as lowercase base32 without padding.
 * @param {Buffer} buffer
 * @returns {string}
 */
function base32(buffer) {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31]
  return out
}

/**
 * Create an opaque prefixed identifier, e.g. `usr_7k3m9q1f3x2v4b6n`.
 * @param {string} prefix
 * @param {number} [bytes]
 * @returns {string}
 */
export function opaqueId(prefix, bytes = 10) {
  return `${prefix}_${base32(randomBytes(bytes))}`
}

/**
 * Create a URL-safe random token (used for session identifiers and virtual keys).
 * @param {number} [bytes]
 * @returns {string}
 */
export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url')
}

/**
 * Hex SHA-256 of a UTF-8 string.
 * @param {string} value
 * @returns {string}
 */
export function sha256Hex(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/**
 * Constant-time string comparison for equal-length secrets.
 * @param {string} left
 * @param {string} right
 * @returns {boolean}
 */
export function timingSafeEqualText(left, right) {
  const a = Buffer.from(left, 'utf8')
  const b = Buffer.from(right, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}
