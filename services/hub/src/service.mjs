/** Hub HTTP app (Unix socket): instance lifecycle, reconcile and idle culling. */
import Fastify from 'fastify'
import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { opaqueId } from '@multi-dsh/shared/ids'
import { generateTenantKey, renderTenantEnv } from '@multi-dsh/tenant'

/**
 * @param {{config: any, store: any, spawner: any, logger: any, now?: () => number}} deps
 */
export function createHub({ config, store, spawner, logger, now = () => Date.now() }) {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 })

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/healthz') return
    if (request.headers.authorization !== `Bearer ${config.token}`) {
      reply.code(401).send({ error: 'unauthorized' })
    }
  })

  async function writeEnvFile(userId, hostPort, virtualKey) {
    const path = join(config.tenantEnvDir, `${userId}.env`)
    await mkdir(config.tenantEnvDir, { recursive: true })
    const content = renderTenantEnv({
      userId,
      hostPort,
      dataDir: join(config.dataRoot, userId, 'data'),
      virtualKey,
      dshImage: config.dshImage,
      dshVersion: config.dshVersion,
      authInternalUrl: config.authInternalUrl,
      authPublicUrl: config.authPublicUrl,
      publicOrigin: config.publicOrigin,
      tenantPath: `/u/${userId}/`,
      tenantCpus: config.tenantCpus,
      tenantMemory: config.tenantMemory,
    })
    await writeFile(path, content, { mode: 0o600 })
    await chmod(path, 0o600)
    return path
  }

  /**
   * Create the instance if needed and ensure its container is running.
   * @param {string} userId
   */
  async function ensureInstance(userId) {
    const user = await store.findUserById(userId)
    if (!user) throw Object.assign(new Error('unknown user'), { statusCode: 404 })

    let instance = await store.getInstance(userId)
    if (!instance) {
      const hostPort = await store.allocatePort(userId)
      if (!hostPort) throw Object.assign(new Error('no free tenant port'), { statusCode: 409 })
      const tenantKey = generateTenantKey()
      await store.createTenantKey({ id: opaqueId('key'), userId, keyHash: tenantKey.keyHash })
      await spawner.ensureDataDir(userId)
      const envFile = await writeEnvFile(userId, hostPort, tenantKey.key)
      instance = await store.upsertInstance({ userId, hostPort, status: 'starting', dshVersion: config.dshVersion })
      try {
        await spawner.start(userId, envFile)
      } catch (error) {
        await store.setInstanceStatus(userId, 'failed')
        throw Object.assign(new Error(`failed to start instance: ${error.message}`), { statusCode: 502 })
      }
      await store.setInstanceStatus(userId, 'ready', { dshVersion: config.dshVersion })
      return { host_port: hostPort, status: 'ready' }
    }

    const envFile = join(config.tenantEnvDir, `${userId}.env`)
    const state = await spawner.status(userId)
    if (state !== 'running') {
      try {
        await spawner.ensureDataDir(userId)
        await spawner.start(userId, envFile)
      } catch (error) {
        await store.setInstanceStatus(userId, 'failed')
        throw Object.assign(new Error(`failed to start instance: ${error.message}`), { statusCode: 502 })
      }
    }
    await store.setInstanceStatus(userId, 'ready', { dshVersion: instance.dsh_version ?? undefined })
    return { host_port: instance.host_port, status: 'ready' }
  }

  /**
   * @param {string} userId
   * @param {string} [reason]
   */
  async function stopInstance(userId, reason) {
    const instance = await store.getInstance(userId)
    if (!instance) throw Object.assign(new Error('unknown instance'), { statusCode: 404 })
    await spawner.stop(userId)
    await store.setInstanceStopped(userId, reason ?? 'manual')
    return { host_port: instance.host_port, status: 'stopped' }
  }

  /** Fix DB status versus actual container state. */
  async function reconcile() {
    const instances = await store.listInstances()
    for (const instance of instances) {
      if (instance.status === 'deleted') continue
      const state = await spawner.status(instance.user_id)
      if (state === 'running' && instance.status !== 'ready') {
        await store.setInstanceStatus(instance.user_id, 'ready')
      } else if (state !== 'running' && instance.status === 'ready') {
        await store.setInstanceStopped(instance.user_id, state ?? 'missing')
      }
    }
  }

  /** Stop tenants with no HTTP/WebSocket activity for longer than the idle timeout. */
  async function cullOnce() {
    if (!(config.idleTimeoutMs > 0)) return []
    const stopped = []
    for (const instance of await store.listInstances()) {
      if (instance.status !== 'ready') continue
      const activity = await spawner.activity(instance.host_port, now)
      if (!activity || activity.openConnections > 0) continue
      const idleFor = now() - Date.parse(activity.lastActivity)
      if (!Number.isFinite(idleFor) || idleFor < config.idleTimeoutMs) continue
      await spawner.stop(instance.user_id)
      await store.setInstanceStopped(instance.user_id, 'idle')
      stopped.push(instance.user_id)
      logger.info({ event: 'instance-culled', userId: instance.user_id, idleMs: idleFor })
    }
    return stopped
  }

  app.post('/internal/instances', async (request, reply) => {
    const body = /** @type {{user_id?: unknown}} */ (request.body ?? {})
    if (typeof body.user_id !== 'string' || body.user_id === '') {
      return reply.code(400).send({ error: 'user_id is required' })
    }
    try {
      return await ensureInstance(body.user_id)
    } catch (error) {
      logger.error({ event: 'ensure-instance-failed', userId: body.user_id, message: String(error?.message ?? error) })
      return reply.code(error?.statusCode ?? 502).send({ error: String(error?.message ?? error) })
    }
  })

  app.post('/internal/instances/:userId/ensure', async (request, reply) => {
    try {
      return await ensureInstance(request.params.userId)
    } catch (error) {
      return reply.code(error?.statusCode ?? 502).send({ error: String(error?.message ?? error) })
    }
  })

  app.post('/internal/instances/:userId/stop', async (request, reply) => {
    const body = /** @type {{reason?: unknown}} */ (request.body ?? {})
    try {
      return await stopInstance(request.params.userId, typeof body.reason === 'string' ? body.reason : undefined)
    } catch (error) {
      return reply.code(error?.statusCode ?? 502).send({ error: String(error?.message ?? error) })
    }
  })

  app.get('/internal/instances/:userId', async (request, reply) => {
    const instance = await store.getInstance(request.params.userId)
    if (!instance) return reply.code(404).send({ error: 'unknown instance' })
    const state = await spawner.status(request.params.userId)
    return { instance, container: state }
  })

  app.get('/healthz', async () => ({ ok: true, service: 'hub' }))

  app.setErrorHandler((error, request, reply) => {
    logger.error({ event: 'request-error', url: request.url, message: String(error?.message ?? error) })
    if (!reply.sent) reply.code(500).send({ error: 'internal hub error' })
  })

  return { app, ensureInstance, stopInstance, reconcile, cullOnce }
}
