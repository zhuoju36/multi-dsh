/** Router configuration. */
import { intEnv, optionalEnv } from '@multi-dsh/shared/config'

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(env = process.env) {
  return {
    host: optionalEnv('ROUTER_HOST', '127.0.0.1', env),
    port: intEnv('ROUTER_PORT', 18000, env),
    authUpstream: optionalEnv('AUTH_UPSTREAM', 'http://127.0.0.1:18080', env).replace(/\/+$/, ''),
    cacheMs: intEnv('ROUTE_CACHE_MS', 5000, env),
  }
}
