/** Gateway configuration; validates at boot and fails closed. */
import { intEnv, optionalEnv } from '../../../packages/shared/src/config.mjs'

/**
 * @typedef {object} GatewayConfig
 * @property {number} listenPort
 * @property {string} dshHost
 * @property {number} dshPort
 * @property {string} tenantId
 * @property {string} userHost
 * @property {string} tenantPath
 * @property {string} tokenFile
 * @property {string} authCookie
 * @property {string} authInternalUrl
 * @property {string} authPublicUrl
 * @property {number} authCacheMs
 * @property {number} dshCookieTtlMs
 * @property {number} maxClientBodyBytes
 * @property {boolean} devMode
 */

/**
 * Validate one absolute http(s) URL without a trailing slash.
 * @param {string} name
 * @param {string} value
 * @returns {string}
 */
function httpUrl(name, value) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${name} must be an absolute URL, got "${value}"`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${name} must use http or https, got "${value}"`)
  }
  return value.replace(/\/+$/, '')
}

/**
 * Load gateway configuration from the environment.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {GatewayConfig}
 */
export function loadConfig(env = process.env) {
  const devMode = env.GATEWAY_DEV_MODE === '1'
  const authInternalUrl = optionalEnv('AUTH_INTERNAL_URL', '', env)
  const authPublicUrl = optionalEnv('AUTH_PUBLIC_URL', '', env)

  if (!devMode) {
    if (!authInternalUrl) throw new Error('AUTH_INTERNAL_URL is required unless GATEWAY_DEV_MODE=1')
    if (!authPublicUrl) throw new Error('AUTH_PUBLIC_URL is required unless GATEWAY_DEV_MODE=1')
  }

  const listenPort = intEnv('LISTEN_PORT', 8080, env)
  return {
    listenPort,
    dshHost: optionalEnv('DSH_HOST', '127.0.0.1', env),
    dshPort: intEnv('DSH_PORT', 3080, env),
    tenantId: optionalEnv('TENANT_ID', 'dev', env),
    userHost: optionalEnv('USER_HOST', `127.0.0.1:${listenPort}`, env),
    tenantPath: (() => {
      let value = optionalEnv('TENANT_PATH', '', env)
      if (value !== '' && !value.startsWith('/')) value = `/${value}`
      if (value !== '' && !value.endsWith('/')) value = `${value}/`
      return value
    })(),
    tokenFile: optionalEnv('TOKEN_FILE', '/run/dsh/launch-token', env),
    authCookie: optionalEnv('AUTH_COOKIE', 'mdsh_session', env),
    authInternalUrl: authInternalUrl ? httpUrl('AUTH_INTERNAL_URL', authInternalUrl) : '',
    authPublicUrl: authPublicUrl ? httpUrl('AUTH_PUBLIC_URL', authPublicUrl) : '',
    authCacheMs: intEnv('AUTH_CACHE_MS', 30_000, env),
    dshCookieTtlMs: intEnv('DSH_COOKIE_TTL_MS', 6 * 3600_000, env),
    maxClientBodyBytes: intEnv('MAX_CLIENT_BODY_BYTES', 320 * 1024 * 1024, env),
    devMode,
  }
}
