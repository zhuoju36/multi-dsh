/** Password hashing for provisioned accounts (same parameters as the auth service). */
import { Algorithm, hash } from '@node-rs/argon2'

/**
 * @param {string} password
 * @returns {Promise<string>}
 */
export function hashPassword(password) {
  return hash(password, {
    algorithm: Algorithm.Argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  })
}
