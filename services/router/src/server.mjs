#!/usr/bin/env node
/** Path-prefix router process. */
import { createServer } from 'node:http'
import { createPool, getInstanceByUser } from '@multi-dsh/db'
import { createLogger } from '@multi-dsh/shared/logger'
import { loadConfig } from './config.mjs'
import { createRouter } from './router.mjs'

async function main() {
  const config = loadConfig()
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')
  const logger = createLogger({ service: 'router', level: process.env.LOG_LEVEL ?? 'info' })
  const pool = createPool({ connectionString: databaseUrl, max: 2 })
  const router = createRouter({
    lookup: (userId) => getInstanceByUser(pool, userId),
    authUpstream: config.authUpstream,
    canonicalHost: `127.0.0.1:${config.port}`,
    cacheMs: config.cacheMs,
    logger,
  })

  const server = createServer((req, res) => {
    router.handle(req, res).catch((error) => {
      logger.error({ event: 'request-error', message: String(error?.message ?? error) })
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'internal router error' }))
    })
  })
  server.requestTimeout = 0
  server.on('upgrade', (req, socket, head) => {
    router.handleUpgrade(req, socket, head).catch((error) => {
      logger.error({ event: 'upgrade-error', message: String(error?.message ?? error) })
      socket.destroy()
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, resolve)
  })
  logger.info({ event: 'listening', host: config.host, port: config.port, auth: config.authUpstream })

  const shutdown = async (signal) => {
    logger.info({ event: 'shutdown', signal })
    await new Promise((resolve) => server.close(resolve))
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
