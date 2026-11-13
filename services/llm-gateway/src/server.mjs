#!/usr/bin/env node
/** LLM gateway: authenticate a tenant virtual key, enforce quota, proxy and meter. */
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'
import { createPool, recordUsage, resolveTenantKey, usageForUserSince } from '@multi-dsh/db'
import { sha256Hex } from '@multi-dsh/shared/ids'
import { createLogger } from '@multi-dsh/shared/logger'
import { loadConfig, monthStart } from './config.mjs'
import { extractKey } from './keys.mjs'
import { resolveRoute } from './routes.mjs'
import { proxyUpstream } from './upstream.mjs'

/**
 * @param {{userId: string, kind: string, model: string | null, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, status: number, durationMs: number}} row
 */
function usageTotal(row) {
  return Number(row.input_tokens ?? 0) + Number(row.output_tokens ?? 0)
}

/**
 * Build the gateway HTTP server (not yet listening).
 * @param {ReturnType<typeof loadConfig>} config
 * @param {{store: any, logger: any, now?: () => number}} deps
 * @returns {import('node:http').Server}
 */
export function createApp(config, { store, logger, now = () => Date.now() }) {
  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handle(req, res) {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, service: 'llm-gateway' }))
      return
    }

    const route = resolveRoute(req.method ?? 'GET', req.url ?? '/', config)
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'unknown route' } }))
      return
    }

    const key = extractKey(req.headers)
    if (!key) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'missing api key' } }))
      return
    }
    const userId = await store.resolveKey(sha256Hex(key))
    if (!userId) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid api key' } }))
      return
    }

    if (config.quotaMonthlyTokens > 0) {
      const usage = await store.usageForUserSince({ userId, since: monthStart(new Date(now())) })
      if (usageTotal(usage) >= config.quotaMonthlyTokens) {
        logger.warn({ event: 'quota-exceeded', userId, used: usageTotal(usage), quota: config.quotaMonthlyTokens })
        res.writeHead(429, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'monthly token quota exceeded' } }))
        return
      }
    }

    proxyUpstream({ req, res, route, config, store, userId, logger, now })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      logger.error({ event: 'request-error', message: String(error?.message ?? error) })
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'internal error' } }))
    })
  })
  server.requestTimeout = 0
  return server
}

async function main() {
  const config = loadConfig()
  const logger = createLogger({ service: 'llm-gateway', level: process.env.LOG_LEVEL ?? 'info' })
  const pool = createPool({ connectionString: config.databaseUrl, max: 10 })
  const store = {
    resolveKey: (keyHash) => resolveTenantKey(pool, keyHash),
    recordUsage: (row) => recordUsage(pool, row),
    usageForUserSince: (options) => usageForUserSince(pool, options),
  }
  const server = createApp(config, { store, logger })
  server.listen(config.port, '0.0.0.0', () => {
    logger.info({ event: 'listening', port: config.port, upstream: config.upstreamBaseUrl, quota: config.quotaMonthlyTokens })
  })
  server.on('error', (error) => {
    logger.error({ event: 'listen-error', message: String(error?.message ?? error) })
    process.exit(1)
  })

  const shutdown = async (signal) => {
    logger.info({ event: 'shutdown', signal })
    server.close(() => void pool.end().finally(() => process.exit(0)))
    setTimeout(() => process.exit(0), 3000).unref()
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('SIGINT', () => void shutdown('SIGINT'))
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}
