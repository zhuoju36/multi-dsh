/** Auth service entry point. */
import { createPool } from '@multi-dsh/db'
import { createLogger } from '@multi-dsh/shared/logger'
import { createApp } from './app.mjs'
import { loadConfig } from './config.mjs'
import { createHubClient } from './hub.mjs'
import { hashPassword, verifyPassword } from './hasher.mjs'
import { createStore } from './store.mjs'

async function main() {
  const config = loadConfig()
  const logger = createLogger({ service: 'auth', level: process.env.LOG_LEVEL ?? 'info' })
  const pool = createPool({ connectionString: config.databaseUrl, max: 5 })
  const hub = config.hubToken
    ? createHubClient({ socketPath: config.hubSocketPath, token: config.hubToken })
    : undefined
  const app = await createApp({
    config,
    store: createStore(pool),
    hasher: { hash: hashPassword, verify: verifyPassword },
    logger,
    hub,
  })
  await app.listen({ port: config.port, host: '0.0.0.0' })
  logger.info({ event: 'listening', port: config.port, publicUrl: config.publicUrl })

  const shutdown = async (signal) => {
    logger.info({ event: 'shutdown', signal })
    await app.close()
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
