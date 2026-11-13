#!/usr/bin/env node
/**
 * multi-dsh gateway: platform session check + DSH launch-token exchange + reverse proxy.
 *
 * Env (see lib/config.mjs):
 *   LISTEN_PORT, DSH_HOST, DSH_PORT, TENANT_ID, USER_HOST, TOKEN_FILE,
 *   AUTH_INTERNAL_URL, AUTH_PUBLIC_URL, AUTH_COOKIE, AUTH_CACHE_MS,
 *   DSH_COOKIE_TTL_MS, MAX_CLIENT_BODY_BYTES, GATEWAY_DEV_MODE
 */
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { pathToFileURL } from 'node:url'
import { createLogger } from '../../packages/shared/src/logger.mjs'
import { loadConfig } from './lib/config.mjs'
import { createAuthorizer, loginUrl } from './lib/auth.mjs'
import { createExchanger } from './lib/exchange.mjs'
import { forwardHttp, forwardUpgrade } from './lib/proxy.mjs'

/**
 * Probe the DSH listener.
 * @param {import('./lib/config.mjs').GatewayConfig} config
 * @returns {Promise<boolean>}
 */
function probeDsh(config) {
  return new Promise((resolve) => {
    const socket = connect(config.dshPort, config.dshHost)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.setTimeout(1000, () => {
      socket.destroy()
      resolve(false)
    })
  })
}

/**
 * Build the gateway HTTP server (not yet listening).
 * @param {import('./lib/config.mjs').GatewayConfig} config
 * @param {{logger?: any, now?: () => number, fetchImpl?: typeof fetch}} [deps]
 * @returns {import('node:http').Server}
 */
export function createApp(config, deps = {}) {
  const logger = deps.logger ?? createLogger({ service: 'gateway', level: process.env.LOG_LEVEL ?? 'info' })
  const clock = deps.now ?? (() => Date.now())
  const activity = { lastActivity: clock(), openConnections: 0 }
  const authorizer = createAuthorizer(config, { logger, now: deps.now, fetchImpl: deps.fetchImpl })
  const exchanger = createExchanger(config, { logger, now: deps.now })
  const sweeper = setInterval(() => {
    authorizer.sweep()
    exchanger.sweep()
  }, 60_000)
  sweeper.unref()

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handle(req, res) {
    if (req.method === 'GET' && req.url === '/internal/activity') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ lastActivity: new Date(activity.lastActivity).toISOString(), openConnections: activity.openConnections }))
      return
    }

    if (req.method === 'GET' && req.url === '/healthz') {
      const ok = await probeDsh(config)
      res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok }))
      return
    }

    activity.lastActivity = clock()
    const declared = Number(req.headers['content-length'] ?? 0)
    if (Number.isFinite(declared) && declared > config.maxClientBodyBytes) {
      res.writeHead(413, { connection: 'close', 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'request body too large' }))
      return
    }

    const auth = await authorizer.authorize(req)
    if (auth.redirect) {
      res.writeHead(303, { location: auth.redirect, 'cache-control': 'no-store' })
      res.end()
      return
    }
    if (auth.status) {
      res.writeHead(auth.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: auth.status === 403 ? 'tenant mismatch' : 'auth unavailable' }))
      return
    }

    let dshCookie = exchanger.get(auth.session)
    if (!dshCookie) {
      let setCookies
      try {
        setCookies = await exchanger.exchange(req.headers.host ?? config.userHost, auth.session)
      } catch (error) {
        logger.error({ event: 'token-exchange-error', tenant: config.tenantId, message: String(error?.message ?? error) })
        setCookies = 'failed'
      }
      if (setCookies === 'not-ready') {
        res.writeHead(503, { 'retry-after': '2', 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'instance starting' }))
        return
      }
      if (setCookies === 'failed') {
        logger.warn({ event: 'token-exchange-failed', tenant: config.tenantId })
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'token exchange failed' }))
        return
      }
      const headers = { location: req.url === '/' ? './' : '/', 'cache-control': 'no-store' }
      if (setCookies) headers['set-cookie'] = setCookies
      res.writeHead(303, headers)
      res.end()
      return
    }

    forwardHttp(req, res, {
      config,
      dshCookie,
      logger,
      onUnauthorized: () => exchanger.drop(auth.session),
    })
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      logger.error({ event: 'request-error', tenant: config.tenantId, message: String(error?.message ?? error) })
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'internal' }))
    })
  })
  // Large attachment uploads (up to the DSH 300 MiB carrier cap) must not hit the
  // default 5-minute request timeout.
  server.requestTimeout = 0

  server.on('upgrade', async (req, socket, head) => {
    try {
      const auth = await authorizer.authorize(req)
      if (auth.redirect || auth.status) {
        socket.write(`HTTP/1.1 ${auth.status ?? 303} ${auth.redirect ? 'See Other' : 'Error'}\r\nConnection: close\r\n\r\n`)
        socket.destroy()
        return
      }
      let dshCookie = exchanger.get(auth.session)
      if (!dshCookie) {
        const result = await exchanger.exchange(req.headers.host ?? config.userHost, auth.session).catch(() => 'failed')
        if (result === 'not-ready' || result === 'failed') {
          socket.write('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 2\r\nConnection: close\r\n\r\n')
          socket.destroy()
          return
        }
        dshCookie = exchanger.get(auth.session)
      }
      activity.openConnections += 1
      activity.lastActivity = clock()
      socket.once('close', () => {
        activity.openConnections = Math.max(0, activity.openConnections - 1)
        activity.lastActivity = clock()
      })
      forwardUpgrade(req, socket, head, { config, dshCookie, logger })
    } catch (error) {
      logger.error({ event: 'upgrade-error', tenant: config.tenantId, message: String(error?.message ?? error) })
      socket.destroy()
    }
  })

  server.on('close', () => clearInterval(sweeper))
  return server
}

export async function main() {
  const config = loadConfig()
  const logger = createLogger({ service: 'gateway', level: process.env.LOG_LEVEL ?? 'info' })
  const server = createApp(config, { logger })
  server.on('error', (error) => {
    logger.error({ event: 'listen-error', message: String(error?.message ?? error) })
    process.exit(1)
  })
  server.listen(config.listenPort, '0.0.0.0', () => {
    logger.info({
      event: 'listening',
      port: config.listenPort,
      tenant: config.tenantId,
      dsh: `http://${config.dshHost}:${config.dshPort}`,
      auth: config.devMode ? 'dev-mode' : config.authInternalUrl,
    })
  })
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      logger.info({ event: 'shutdown', signal })
      server.close(() => process.exit(0))
      setTimeout(() => process.exit(0), 3000).unref()
    })
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}

export { loginUrl }
