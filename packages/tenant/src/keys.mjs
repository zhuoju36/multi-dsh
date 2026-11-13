/** Tenant virtual key generation: the plaintext is shown once, only the hash is stored. */
import { randomToken, sha256Hex } from '@multi-dsh/shared/ids'

/**
 * @returns {{key: string, keyHash: string}}
 */
export function generateTenantKey() {
  const key = `sk-mdsh-${randomToken(24)}`
  return { key, keyHash: sha256Hex(key) }
}
