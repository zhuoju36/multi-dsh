/** Path-prefix router: /u/<user-id>/... -> tenant gateway, everything else -> auth. */
import { request } from 'node:http'
import { connect } from 'node:net'

/**
 * Rewrite the DSH cookie scope to the tenant prefix.
 * @param {string} cookie
 * @param {string} prefix e.g. /u/usr_abc/
 * @returns {string}
 */
export function rewriteCookiePath(cookie, prefix) {
  if (/;\s*path=/i.test(cookie)) return cookie.replace(/;\s*path=[^;]*/i, `; Path=${prefix}`)
  return `${cookie}; Path=${prefix}`
}

/**
 * Rewrite an absolute root-relative redirect to the tenant prefix.
 * Relative locations ("./") are left alone.
 * @param {string} location
 * @param {string} prefix
 * @returns {string}
 */
export function rewriteLocation(location, prefix) {
  if (typeof location !== 'string' || !location.startsWith('/') || location.startsWith('//')) return location
  return `${prefix.replace(/\/$/, '')}${location}`
}

/**
 * @param {{
 *   lookup: (userId: string) => Promise<{host_port: number, status: string} | null>,
 *   authUpstream: string,
 *   canonicalHost?: string,
 *   cacheMs?: number,
 *   logger: {info: Function, warn: Function, error: Function},
 * }} deps
 */
export function createRouter({ lookup, authUpstream, canonicalHost = '', cacheMs = 5000, logger }) {
  const authUrl = new URL(authUpstream)
  /** @type {Map<string, {value: {host_port: number, status: string} | null, expiresAt: number}>} */
  const cache = new Map()
  const now = () => Date.now()

  /**
   * @param {string} userId
   */
  async function resolve(userId) {
    const hit = cache.get(userId)
    if (hit && hit.expiresAt > now()) return hit.value
    let value = null
    try {
      value = await lookup(userId)
    } catch (error) {
      logger.warn({ event: 'route-lookup-failed', userId, message: String(error?.message ?? error) })
    }
    cache.set(userId, { value, expiresAt: now() + cacheMs })
    return value
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {number} port
   * @param {string} path
   * @param {string} prefix
   */
  function proxyTenant(req, res, port, path, prefix) {
    const headers = { ...req.headers }
    headers.host = req.headers.host
    const upstream = request(
      { host: '127.0.0.1', port, method: req.method, path, headers },
      (upstreamRes) => {
        const headersOut = { ...upstreamRes.headers }
        if (headersOut['set-cookie']) {
          const cookies = Array.isArray(headersOut['set-cookie']) ? headersOut['set-cookie'] : [headersOut['set-cookie']]
          headersOut['set-cookie'] = cookies.map((cookie) => rewriteCookiePath(String(cookie), prefix))
        }
        if (headersOut.location) headersOut.location = rewriteLocation(headersOut.location, prefix)
        res.writeHead(upstreamRes.statusCode ?? 502, headersOut)
        upstreamRes.pipe(res)
      },
    )
    upstream.on('error', (error) => {
      logger.error({ event: 'tenant-proxy-error', port, message: String(error?.message ?? error) })
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'bad gateway' }))
    })
    res.on('close', () => { if (!res.writableEnded) upstream.destroy() })
    req.pipe(upstream)
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  function proxyAuth(req, res) {
    const headers = { ...req.headers, host: req.headers.host }
    const upstream = request(
      { host: authUrl.hostname, port: Number(authUrl.port || 80), method: req.method, path: req.url, headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers)
        upstreamRes.pipe(res)
      },
    )
    upstream.on('error', (error) => {
      logger.error({ event: 'auth-proxy-error', message: String(error?.message ?? error) })
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'auth unavailable' }))
    })
    res.on('close', () => { if (!res.writableEnded) upstream.destroy() })
    req.pipe(upstream)
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   */
  async function handle(req, res) {
    const host = req.headers.host ?? ''
    if (canonicalHost && /^localhost(:\d+)?$/i.test(host)) {
      res.writeHead(301, { location: `http://${canonicalHost}${req.url ?? '/'}` })
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://router')
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, service: 'router' }))
      return
    }

    const bare = /^\/u\/(usr_[A-Za-z0-9]+)$/.exec(url.pathname)
    if (bare) {
      res.writeHead(301, { location: `/u/${bare[1]}/${url.search}` })
      res.end()
      return
    }

    const match = /^\/u\/(usr_[A-Za-z0-9]+)(\/.*)$/.exec(url.pathname)
    if (match) {
      const userId = match[1]
      const instance = await resolve(userId)
      if (!instance) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'unknown tenant' }))
        return
      }
      if (instance.status !== 'ready') {
        res.writeHead(503, { 'retry-after': '5', 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'instance not ready', status: instance.status }))
        return
      }
      const path = `${match[2]}${url.search}`
      proxyTenant(req, res, instance.host_port, path, `/u/${userId}/`)
      return
    }

    proxyAuth(req, res)
  }

  /**
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:stream').Duplex} socket
   * @param {Buffer} head
   */
  async function handleUpgrade(req, socket, head) {
    const url = new URL(req.url ?? '/', 'http://router')
    const match = /^\/u\/(usr_[A-Za-z0-9]+)(\/.*)$/.exec(url.pathname)
    if (!match) {
      socket.destroy()
      return
    }
    const userId = match[1]
    const instance = await resolve(userId)
    if (!instance || instance.status !== 'ready') {
      socket.write(`HTTP/1.1 ${instance ? 503 : 404} ${instance ? 'Service Unavailable' : 'Not Found'}\r\nConnection: close\r\n\r\n`)
      socket.destroy()
      return
    }
    const path = `${match[2]}${url.search}`
    const upstream = connect(instance.host_port, '127.0.0.1', () => {
      const headers = { ...req.headers, host: req.headers.host }
      const lines = [`${req.method} ${path} HTTP/1.1`]
      for (const [name, value] of Object.entries(headers)) {
        if (value === undefined) continue
        for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`)
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head?.length) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    socket.on('close', () => upstream.destroy())
  }

  return { handle, handleUpgrade, resolve, cache }
}
