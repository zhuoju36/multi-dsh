/** Transparent upstream proxy with SSE usage capture. */
import http from 'node:http'
import https from 'node:https'
import { createUsageTracker } from './sse.mjs'

const HOP_BY_HOP = ['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']

/**
 * Build upstream headers: replace the tenant virtual key with the platform key.
 * @param {Record<string, string | string[] | undefined>} incoming
 * @param {'messages' | 'files' | 'models' | 'tools'} kind
 * @param {{platformApiKey: string}} config
 * @returns {Record<string, string | string[] | undefined>}
 */
export function upstreamRequestHeaders(incoming, kind, config) {
  /** @type {Record<string, string | string[] | undefined>} */
  const headers = { ...incoming }
  for (const name of HOP_BY_HOP) delete headers[name]
  delete headers['x-api-key']
  delete headers.authorization
  // Identity avoids a gzip stream the usage parser cannot read; the client gets plain bytes.
  headers['accept-encoding'] = 'identity'
  if (kind === 'tools') headers.authorization = `Bearer ${config.platformApiKey}`
  else headers['x-api-key'] = config.platformApiKey
  return headers
}

/**
 * @param {{
 *   req: import('node:http').IncomingMessage,
 *   res: import('node:http').ServerResponse,
 *   route: import('./routes.mjs').Route,
 *   config: {platformApiKey: string, requestTimeoutMs: number},
 *   store: {recordUsage: (row: object) => Promise<void>},
 *   userId: string,
 *   logger: any,
 *   now?: () => number,
 * }} options
 */
export function proxyUpstream({ req, res, route, config, store, userId, logger, now = Date.now }) {
  const target = new URL(route.upstream)
  const client = target.protocol === 'https:' ? https : http
  const startedAt = now()
  const tracker = createUsageTracker()
  let recorded = false

  async function record(status) {
    if (recorded) return
    recorded = true
    const usage = tracker.finish()
    try {
      await store.recordUsage({
        userId,
        kind: route.kind,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        status,
        durationMs: now() - startedAt,
      })
    } catch (error) {
      logger.error({ event: 'usage-record-failed', userId, message: String(error?.message ?? error) })
    }
  }

  const upstreamReq = client.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || undefined,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: upstreamRequestHeaders(req.headers, route.kind, config),
    },
    (upstreamRes) => {
      const status = upstreamRes.statusCode ?? 502
      const isSse = String(upstreamRes.headers['content-type'] ?? '').includes('text/event-stream')
      const responseHeaders = { ...upstreamRes.headers }
      delete responseHeaders.connection
      delete responseHeaders['keep-alive']
      delete responseHeaders['transfer-encoding']
      res.writeHead(status, responseHeaders)
      if (isSse) upstreamRes.on('data', (chunk) => tracker.feed(chunk))
      upstreamRes.pipe(res)
      upstreamRes.on('end', () => void record(status))
      upstreamRes.on('error', () => res.destroy())
    },
  )

  upstreamReq.on('error', (error) => {
    logger.error({ event: 'upstream-error', userId, kind: route.kind, message: String(error?.message ?? error) })
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'upstream request failed' } }))
    } else {
      res.destroy()
    }
    void record(502)
  })
  upstreamReq.setTimeout(config.requestTimeoutMs, () => upstreamReq.destroy(new Error('upstream timeout')))

  res.on('close', () => {
    if (!res.writableEnded) {
      upstreamReq.destroy()
      void record(499)
    }
  })

  req.pipe(upstreamReq)
}
