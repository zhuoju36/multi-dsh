/** Auth service configuration. */
import { boolEnv, intEnv, optionalEnv, requireEnv } from '@multi-dsh/shared/config'

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(env = process.env) {
  return {
    port: intEnv('PORT', 18080, env),
    databaseUrl: requireEnv('DATABASE_URL', env),
    cookieName: optionalEnv('AUTH_COOKIE', 'mdsh_session', env),
    /** Browser-facing origin, used to validate Origin headers on form posts. */
    publicUrl: optionalEnv('AUTH_PUBLIC_URL', 'http://127.0.0.1:18000', env).replace(/\/+$/, ''),
    sessionTtlMs: intEnv('SESSION_TTL_HOURS', 12, env) * 3600_000,
    loginWindowMs: intEnv('LOGIN_WINDOW_MINUTES', 5, env) * 60_000,
    maxLoginFailures: intEnv('LOGIN_MAX_FAILURES', 5, env),
    secureCookie: boolEnv('AUTH_COOKIE_SECURE', false, env),
    hubSocketPath: optionalEnv('HUB_SOCKET', '/run/multi-dsh/hub.sock', env),
    hubToken: optionalEnv('HUB_TOKEN', '', env),
  }
}
