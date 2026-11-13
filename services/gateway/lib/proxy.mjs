/** Reverse proxy to the loopback DSH listener: HTTP streaming and WebSocket upgrades. */
import { request } from 'node:http'
import { connect } from 'node:net'
import { stripCookies } from '../../../packages/shared/src/cookies.mjs'

/**
 * Build upstream headers: keep the browser Host, drop the platform cookie, add the DSH cookie.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('./config.mjs').GatewayConfig} config
 * @param {string | undefined} dshCookie
 * @returns {Record<string, string | string[] | undefined>}
 */
export function upstreamHeaders(req, config, dshCookie) {
  const headers = { ...req.headers }
  headers.host = req.headers.host ?? config.userHost
  const browserCookies = stripCookies(req.headers.cookie, [config.authCookie])
  if (dshCookie) headers.cookie = browserCookies ? `${browserCookies}; ${dshCookie}` : dshCookie
  else if (browserCookies) headers.cookie = browserCookies
  else delete headers.cookie
  return headers
}

/**
 * Proxy one HTTP request. A 401 from DSH drops the cached cookie and asks the browser to retry.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{config: import('./config.mjs').GatewayConfig, dshCookie: string, onUnauthorized: () => void, logger: any}} options
 */
export function forwardHttp(req, res, { config, dshCookie, onUnauthorized, logger }) {
  const upstream = request(
    {
      host: config.dshHost,
      port: config.dshPort,
      method: req.method,
      path: req.url,
      headers: upstreamHeaders(req, config, dshCookie),
    },
    (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502
      if (status === 401) {
        upstreamRes.resume()
        onUnauthorized()
        res.writeHead(303, { location: req.url === '/' ? './' : '/', 'cache-control': 'no-store' })
        res.end()
        return
      }
      res.writeHead(status, upstreamRes.headers)
      upstreamRes.pipe(res)
    },
  )
  upstream.on('error', (error) => {
    logger.error({ event: 'proxy-error', tenant: config.tenantId, message: String(error?.message ?? error) })
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'bad gateway' }))
  })
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy()
  })
  req.pipe(upstream)
}

/**
 * Proxy one WebSocket upgrade, preserving Upgrade/Connection headers and the Host.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:stream').Duplex} socket
 * @param {Buffer} head
 * @param {{config: import('./config.mjs').GatewayConfig, dshCookie: string, logger: any}} options
 */
export function forwardUpgrade(req, socket, head, { config, dshCookie, logger }) {
  const upstream = connect(config.dshPort, config.dshHost, () => {
    const headers = upstreamHeaders(req, config, dshCookie)
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (const [name, value] of Object.entries(headers)) {
      if (value === undefined) continue
      for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`)
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head?.length) upstream.write(head)
    socket.pipe(upstream)
    upstream.pipe(socket)
  })
  upstream.on('error', (error) => {
    logger.error({ event: 'upgrade-error', tenant: config.tenantId, message: String(error?.message ?? error) })
    socket.destroy()
  })
  socket.on('error', () => upstream.destroy())
  socket.on('close', () => upstream.destroy())
}
