/** Provisioner configuration: host paths, compose assets and public URLs. */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { intEnv, optionalEnv, requireEnv } from '@multi-dsh/shared/config'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..')

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export function loadConfig(env = process.env) {
  return {
    databaseUrl: requireEnv('DATABASE_URL', env),
    repoRoot: optionalEnv('REPO_ROOT', REPO_ROOT, env),
    dataRoot: optionalEnv('DATA_ROOT', '/srv/multi-dsh/volumes', env),
    composeFile: optionalEnv('TENANT_COMPOSE_FILE', join(REPO_ROOT, 'deploy/compose/compose.tenant.yml'), env),
    tenantEnvDir: optionalEnv('TENANT_ENV_DIR', join(REPO_ROOT, 'deploy/compose/tenants'), env),
    authInternalUrl: optionalEnv('AUTH_INTERNAL_URL', 'http://auth:18080', env),
    authPublicUrl: optionalEnv('AUTH_PUBLIC_URL', 'http://127.0.0.1:18000', env),
    publicOrigin: optionalEnv('PUBLIC_ORIGIN', optionalEnv('AUTH_PUBLIC_URL', 'http://127.0.0.1:18000', env), env).replace(/\/+$/, ''),
    dshImage: optionalEnv('DSH_IMAGE', 'multi-dsh/dsh:dev', env),
    dshVersion: optionalEnv('DSH_VERSION', '', env),
    dockerBin: optionalEnv('DOCKER_BIN', 'docker', env),
    quotaTokens: intEnv('MONTHLY_QUOTA_TOKENS', 0, env),
    tenantCpus: optionalEnv('TENANT_CPUS', '2', env),
    tenantMemory: optionalEnv('TENANT_MEMORY', '2g', env),
  }
}
