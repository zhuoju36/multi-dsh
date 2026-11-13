/** LLM gateway configuration. */
import { intEnv, optionalEnv, requireEnv } from '@multi-dsh/shared/config'

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(env = process.env) {
  const upstreamBaseUrl = optionalEnv('UPSTREAM_BASE_URL', 'https://api.deepseek.com/anthropic', env).replace(/\/+$/, '')
  let upstream
  try {
    upstream = new URL(upstreamBaseUrl)
  } catch {
    throw new Error(`UPSTREAM_BASE_URL must be an absolute URL, got "${upstreamBaseUrl}"`)
  }
  if (upstream.protocol !== 'https:' && upstream.protocol !== 'http:') {
    throw new Error('UPSTREAM_BASE_URL must use http or https')
  }
  return {
    port: intEnv('PORT', 18090, env),
    databaseUrl: requireEnv('DATABASE_URL', env),
    platformApiKey: requireEnv('PLATFORM_API_KEY', env),
    upstreamBaseUrl,
    upstreamOrigin: upstream.origin,
    /** 0 disables the monthly token quota. */
    quotaMonthlyTokens: intEnv('MONTHLY_QUOTA_TOKENS', 0, env),
    requestTimeoutMs: intEnv('UPSTREAM_TIMEOUT_MS', 600_000, env),
  }
}

/**
 * First instant of the current UTC month; quota windows are UTC.
 * @param {Date} [now]
 * @returns {Date}
 */
export function monthStart(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
}
