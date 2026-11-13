/** Platform-session authorization: introspect the auth service and bind to one tenant. */
import { parseCookies } from '../../../packages/shared/src/cookies.mjs'

/**
 * Browser-facing login URL for this instance.
 * @param {import('./config.mjs').GatewayConfig} config
 * @returns {string}
 */
export function loginUrl(config) {
  const target = `http://${config.userHost}${config.tenantPath || '/'}`
  return `${config.authPublicUrl}/login?next=${encodeURIComponent(target)}`
}

/**
 * Create the request authorizer with a short-lived introspection cache.
 * @param {import('./config.mjs').GatewayConfig} config
 * @param {{logger: {info: Function, warn: Function, error: Function}, now?: () => number, fetchImpl?: typeof fetch}} deps
 */
export function createAuthorizer(config, { logger, now = () => Date.now(), fetchImpl = fetch }) {
  /** @type {Map<string, {userId: string, expiresAt: number}>} */
  const cache = new Map()

  /**
   * Resolve a platform session to a user id.
   * @param {string} session
   * @returns {Promise<string | null | undefined>} user id, null for rejected, undefined for auth unavailable
   */
  async function introspect(session) {
    const hit = cache.get(session)
    if (hit && hit.expiresAt > now()) return hit.userId
    let response
    try {
      response = await fetchImpl(`${config.authInternalUrl}/introspect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ session }),
        signal: AbortSignal.timeout(3000),
      })
    } catch (error) {
      logger.warn({ event: 'introspect-error', message: String(error?.message ?? error) })
      return undefined
    }
    if (response.status === 401) return null
    if (!response.ok) {
      logger.warn({ event: 'introspect-status', status: response.status })
      return undefined
    }
    let body
    try {
      body = await response.json()
    } catch {
      return undefined
    }
    if (typeof body?.user_id !== 'string' || body.user_id === '') return undefined
    cache.set(session, { userId: body.user_id, expiresAt: now() + config.authCacheMs })
    return body.user_id
  }

  /**
   * Authorize one browser request.
   * @param {import('node:http').IncomingMessage} req
   * @returns {Promise<{session: string} | {redirect: string} | {status: number}>}
   */
  async function authorize(req) {
    if (config.devMode) return { session: 'dev' }
    const session = parseCookies(req.headers.cookie)[config.authCookie]
    if (!session) return { redirect: loginUrl(config) }
    const userId = await introspect(session)
    if (userId === null) return { redirect: loginUrl(config) }
    if (userId === undefined) return { status: 503 }
    if (userId !== config.tenantId) return { status: 403 }
    return { session }
  }

  function sweep() {
    const current = now()
    for (const [key, value] of cache) if (value.expiresAt <= current) cache.delete(key)
  }

  return { authorize, sweep, cache }
}
