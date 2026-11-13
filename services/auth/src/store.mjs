/** Store adapter: the auth service only sees this interface, so it is testable without PostgreSQL. */
import {
  countRecentFailures,
  createSession,
  findInviteByCodeHash,
  registerUserWithInvite,
  resetPasswordWithInvite,
  findInstanceByPort,
  findSession,
  findUserByUsername,
  getInstanceByUser,
  recordLoginAttempt,
  revokeSession,
  touchSession,
  writeAudit,
} from '@multi-dsh/db'

/**
 * @param {import('pg').Pool} pool
 */
export function createStore(pool) {
  return {
    /** @param {string} username */
    findUserByUsername: (username) => findUserByUsername(pool, username),
    /** @param {number} hostPort */
    findInstanceByPort: (hostPort) => findInstanceByPort(pool, hostPort),
    /** @param {string} userId */
    getInstanceByUser: (userId) => getInstanceByUser(pool, userId),
    /** @param {string} codeHash */
    findInviteByCodeHash: (codeHash) => findInviteByCodeHash(pool, codeHash),
    /** @param {{id: string, username: string, passwordHash: string, codeHash: string}} input */
    registerUserWithInvite: (input) => registerUserWithInvite(pool, input),
    /** @param {{codeHash: string, passwordHash: string}} input */
    resetPasswordWithInvite: (input) => resetPasswordWithInvite(pool, input),
    /** @param {{idHash: string, userId: string, ttlMs: number}} session */
    createSession: (session) => createSession(pool, session),
    /** @param {string} idHash */
    findSession: (idHash) => findSession(pool, idHash),
    /** @param {string} idHash */
    touchSession: (idHash) => touchSession(pool, idHash),
    /** @param {string} idHash */
    revokeSession: (idHash) => revokeSession(pool, idHash),
    /** @param {{username: string, ip: string | null, windowMs: number}} options */
    countRecentFailures: (options) => countRecentFailures(pool, options),
    /** @param {{username: string, ip: string | null, ok: boolean}} attempt */
    recordLoginAttempt: (attempt) => recordLoginAttempt(pool, attempt),
    /** @param {object} entry */
    writeAudit: (entry) => writeAudit(pool, entry),
    async ping() {
      await pool.query('SELECT 1')
    },
  }
}
