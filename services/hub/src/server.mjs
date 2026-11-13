#!/usr/bin/env node
/** Hub host service: listens on a Unix socket and supervises tenant containers. */
import { chmod, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createPool } from '@multi-dsh/db'
import { createLogger } from '@multi-dsh/shared/logger'
import { loadConfig } from './config.mjs'
import { createHub } from './service.mjs'
import { createDockerSpawner } from './spawner.mjs'
import { createStore } from './store.mjs'

async function main() {
  const config = loadConfig()
  const logger = createLogger({ service: 'hub', level: process.env.LOG_LEVEL ?? 'info' })
  const pool = createPool({ connectionString: config.databaseUrl, max: 5 })
  const store = createStore(pool)
  const spawner = createDockerSpawner(config)
  const hub = createHub({ config, store, spawner, logger })

  await mkdir(dirname(config.socketPath), { recursive: true, mode: 0o700 })
  await rm(config.socketPath, { force: true })
  await hub.app.listen({ path: config.socketPath })
  await chmod(config.socketPath, 0o600)

  if (config.reconcileOnStart) {
    await hub.reconcile().catch((error) => logger.error({ event: 'reconcile-failed', message: String(error?.message ?? error) }))
  }
  const culler = setInterval(() => {
    hub.cullOnce().catch((error) => logger.error({ event: 'cull-failed', message: String(error?.message ?? error) }))
  }, config.cullIntervalMs)
  culler.unref()

  logger.info({
    event: 'listening',
    socket: config.socketPath,
    idleTimeoutMs: config.idleTimeoutMs,
    reconcileOnStart: config.reconcileOnStart,
  })

  const shutdown = async (signal) => {
    logger.info({ event: 'shutdown', signal })
    clearInterval(culler)
    await hub.app.close()
    await pool.end()
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
