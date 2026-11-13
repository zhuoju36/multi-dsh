/** Hub configuration: reads the platform env file and host paths. */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { optionalEnv } from '@multi-dsh/shared/config'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')

/**
 * Parse a simple KEY=VALUE env file (comments and blank lines ignored).
 * @param {string} path
 * @returns {Record<string, string>}
 */
export function readEnvFile(path) {
  if (!existsSync(path)) return {}
  /** @type {Record<string, string>} */
  const out = {}
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index < 1) continue
    const name = line.slice(0, index).trim()
    let value = line.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    out[name] = value
  }
  return out
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(env = process.env) {
  const platformFile = optionalEnv('PLATFORM_ENV_FILE', '/srv/multi-dsh/secrets/platform.env', env)
  const platform = readEnvFile(platformFile)
  const get = (name, fallback) => env[name] ?? platform[name] ?? fallback

  const user = get('POSTGRES_USER', 'multi_dsh')
  const password = get('POSTGRES_PASSWORD', '')
  const port = get('POSTGRES_PORT', '5432')
  const database = get('POSTGRES_DB', 'multi_dsh')
  const token = get('HUB_TOKEN', '')
  if (!token) throw new Error('HUB_TOKEN is missing (platform env or process env)')
  if (!password) throw new Error('POSTGRES_PASSWORD is missing (platform env or process env)')

  return {
    socketPath: optionalEnv('HUB_SOCKET', '/srv/multi-dsh/run/hub.sock', env),
    databaseUrl: env.DATABASE_URL ?? `postgres://${user}:${password}@127.0.0.1:${port}/${database}`,
    token,
    repoRoot: optionalEnv('REPO_ROOT', REPO_ROOT, env),
    dataRoot: get('DATA_ROOT', '/srv/multi-dsh/volumes'),
    composeFile: get('TENANT_COMPOSE_FILE', join(REPO_ROOT, 'deploy/compose/compose.tenant.yml')),
    tenantEnvDir: get('TENANT_ENV_DIR', join(REPO_ROOT, 'deploy/compose/tenants')),
    dshImage: get('DSH_IMAGE', 'multi-dsh/dsh:0.2.2-rc.2'),
    dshVersion: get('DSH_VERSION', '0.2.2-rc.2'),
    tenantCpus: get('TENANT_CPUS', '2'),
    tenantMemory: get('TENANT_MEMORY', '1536m'),
    authInternalUrl: get('AUTH_INTERNAL_URL', 'http://auth:18080'),
    authPublicUrl: get('AUTH_PUBLIC_URL', 'http://127.0.0.1:18000'),
    publicOrigin: get('PUBLIC_ORIGIN', get('AUTH_PUBLIC_URL', 'http://127.0.0.1:18000')).replace(/\/+$/, ''),
    dockerBin: get('DOCKER_BIN', 'docker'),
    helperImage: get('HELPER_IMAGE', 'node:24-slim'),
    idleTimeoutMs: Number(get('IDLE_TIMEOUT_MS', '0')) || 0,
    cullIntervalMs: Number(get('CULL_INTERVAL_MS', '60000')) || 60_000,
    reconcileOnStart: get('RECONCILE_ON_START', '1') !== '0',
  }
}
