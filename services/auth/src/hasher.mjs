/** Argon2id password hashing. */
import { Algorithm, hash, verify } from '@node-rs/argon2'

const OPTIONS = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
}

/**
 * @param {string} password
 * @returns {Promise<string>}
 */
export function hashPassword(password) {
  return hash(password, OPTIONS)
}

/**
 * @param {string} digest
 * @param {string} password
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(digest, password) {
  try {
    return await verify(digest, password)
  } catch {
    return false
  }
}
