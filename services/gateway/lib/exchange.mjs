/** DSH launch-token exchange, cached per platform session. */
import { readFile } from 'node:fs/promises'
import { request } from 'node:http'

/**
 * Create the token exchanger.
 * @param {import('./config.mjs').GatewayConfig} config
 * @param {{logger: {info: Function, warn: Function, error: Function}, now?: () => number}} deps
 */
export function createExchanger(config, { logger, now = () => Date.now() }) {
  /** @type {Map<string, {cookie: string, expiresAt: number}>} */
  const cache = new Map()

  /**
   * @param {string} session
   * @returns {string | undefined}
   */
  function get(session) {
    const hit = cache.get(session)
    return hit && hit.expiresAt > now() ? hit.cookie : undefined
  }

  /**
   * Exchange the launch token for a DSH cookie bound to the browser's authority.
   * @param {string} hostHeader
   * @param {string} session
   * @returns {Promise<string[] | 'not-ready' | 'failed'>}
   */
  async function exchange(hostHeader, session) {
    let raw
    try {
      raw = await readFile(config.tokenFile, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return 'not-ready'
      throw error
    }
    const token = raw.trim()
    if (!token) return 'not-ready'

    // Must use http.request: fetch() ignores a custom Host header, and DSH binds
    // the signed cookie to the Host it receives.
    const setCookies = await new Promise((resolve, reject) => {
      const upstream = request(
        {
          host: config.dshHost,
          port: config.dshPort,
          method: 'GET',
          path: `/?token=${encodeURIComponent(token)}`,
          headers: { host: hostHeader },
        },
        (response) => {
          response.resume()
          resolve(response.headers['set-cookie'] ?? [])
        },
      )
      upstream.on('error', reject)
      upstream.setTimeout(5000, () => upstream.destroy(new Error('token exchange timeout')))
      upstream.end()
    })

    if (setCookies.length === 0) return 'failed'
    const cookie = setCookies.map((entry) => entry.split(';')[0]).join('; ')
    cache.set(session, { cookie, expiresAt: now() + config.dshCookieTtlMs })
    logger.info({ event: 'token-exchanged', tenant: config.tenantId, host: hostHeader })
    return setCookies
  }

  /**
   * @param {string} session
   */
  function drop(session) {
    cache.delete(session)
  }

  function sweep() {
    const current = now()
    for (const [key, value] of cache) if (value.expiresAt <= current) cache.delete(key)
  }

  return { get, exchange, drop, sweep, cache }
}
