/** Hub store adapter over the shared PostgreSQL repositories. */
import {
  allocatePort,
  createTenantKey,
  findUserById,
  getInstanceByUser,
  listInstances,
  setInstanceStatus,
  setInstanceStopped,
  upsertInstance,
} from '@multi-dsh/db'

/**
 * @param {import('pg').Pool} pool
 */
export function createStore(pool) {
  return {
    /** @param {string} userId */
    findUserById: (userId) => findUserById(pool, userId),
    /** @param {string} userId */
    getInstance: (userId) => getInstanceByUser(pool, userId),
    /** @param {string} userId */
    allocatePort: (userId) => allocatePort(pool, userId),
    /** @param {{id: string, userId: string, keyHash: string}} key */
    createTenantKey: (key) => createTenantKey(pool, key),
    /** @param {object} instance */
    upsertInstance: (instance) => upsertInstance(pool, instance),
    /** @param {string} userId @param {string} status @param {object} [meta] */
    setInstanceStatus: (userId, status, meta) => setInstanceStatus(pool, userId, status, meta),
    /** @param {string} userId @param {string} [reason] */
    setInstanceStopped: (userId, reason) => setInstanceStopped(pool, userId, reason),
    listInstances: () => listInstances(pool),
  }
}
