/** Render the per-tenant env file consumed by `docker compose --env-file`. */

/**
 * @param {{
 *   userId: string,
 *   hostPort: number,
 *   dataDir: string,
 *   virtualKey: string,
 *   dshImage: string,
 *   dshVersion?: string,
 *   authInternalUrl: string,
 *   authPublicUrl: string,
 *   publicOrigin?: string,
 *   tenantPath?: string,
 *   quotaTokens?: number,
 *   tenantCpus?: string,
 *   tenantMemory?: string,
 * }} input
 * @returns {string}
 */
export function renderTenantEnv(input) {
  for (const [name, value] of Object.entries(input)) {
    if (typeof value === 'string' && /[\n\r]/.test(value)) throw new Error(`tenant env value ${name} contains a newline`)
  }
  const publicOrigin = input.publicOrigin ? input.publicOrigin.replace(/\/+$/, '') : ''
  const tenantPath = input.tenantPath ?? (publicOrigin ? `/u/${input.userId}/` : '')
  const publicHost = publicOrigin ? new URL(publicOrigin).host : ''
  const userHost = publicHost || `127.0.0.1:${input.hostPort}`
  const entries = [
    ['USER_ID', input.userId],
    ['HOST_PORT', String(input.hostPort)],
    ['USER_HOST', userHost],
    ['TENANT_PATH', tenantPath],
    ['PUBLIC_ORIGIN', publicOrigin],
    ['DSH_PUBLIC_URL', publicOrigin ? `${publicOrigin}${tenantPath}` : ''],
    ['DSH_TRUSTED_HOST', publicHost],
    ['DATA_DIR', input.dataDir],
    ['TENANT_KEY', input.virtualKey],
    ['DSH_IMAGE', input.dshImage],
    ['DSH_VERSION', input.dshVersion ?? ''],
    ['AUTH_INTERNAL_URL', input.authInternalUrl],
    ['AUTH_PUBLIC_URL', input.authPublicUrl],
    ['MONTHLY_QUOTA_TOKENS', String(input.quotaTokens ?? 0)],
    ['TENANT_CPUS', input.tenantCpus ?? '2'],
    ['TENANT_MEMORY', input.tenantMemory ?? '2g'],
  ]
  return `${entries.map(([name, value]) => `${name}=${value}`).join('\n')}\n`
}
