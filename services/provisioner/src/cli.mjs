#!/usr/bin/env node
/**
 * multi-dsh provisioner (host-side CLI).
 *
 *   node services/provisioner/src/cli.mjs create --username alice [--user usr_x] [--password ...] [--image ...]
 *   node services/provisioner/src/cli.mjs delete --user usr_x
 *   node services/provisioner/src/cli.mjs rotate-key --user usr_x
 *   node services/provisioner/src/cli.mjs usage [--month 2026-11]
 *   node services/provisioner/src/cli.mjs status
 */
import { chmod, chown, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import {
  allocatePort,
  createPool,
  createTenantKey,
  createUser,
  disableUser,
  findUserById,
  findUserByUsername,
  getInstanceByUser,
  listInstances,
  releasePort,
  revokeTenantKeys,
  setInstanceStatus,
  upsertInstance,
  usageByUserSince,
  writeAudit,
} from '@multi-dsh/db'
import { opaqueId, randomToken } from '@multi-dsh/shared/ids'
import { runCompose } from '@multi-dsh/tenant'
import { loadConfig } from './config.mjs'
import { generateTenantKey } from '@multi-dsh/tenant'
import { hashPassword } from './password.mjs'
import { renderTenantEnv } from '@multi-dsh/tenant'
import { monthRange } from './usage.mjs'

const HELP = `multi-dsh provisioner

commands:
  create --username <name> [--user <usr_id>] [--password <pw>] [--image <tag>]
  delete --user <usr_id>
  rotate-key --user <usr_id> [--image <tag>]
  usage [--month YYYY-MM]
  status

env: DATABASE_URL (required), DATA_ROOT, DSH_IMAGE, DSH_VERSION,
     AUTH_INTERNAL_URL, AUTH_PUBLIC_URL, TENANT_COMPOSE_FILE, TENANT_ENV_DIR
`

/**
 * @param {string | boolean | undefined} value
 * @param {string} name
 * @returns {string}
 */
function requireString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} is required`)
  return value
}

/**
 * @param {string} dir
 */
async function prepareDataDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    try {
      await chown(dir, 10_001, 10_001)
    } catch (error) {
      console.warn(`warning: chown ${dir} failed: ${error.message}`)
    }
  }
}

/**
 * @param {string} path
 * @param {string} content
 */
async function writeEnvFile(path, content) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, content, { mode: 0o600 })
  await chmod(path, 0o600)
}

/**
 * @param {import('pg').Pool} pool
 * @param {ReturnType<typeof loadConfig>} config
 * @param {{username?: string|boolean, user?: string|boolean, password?: string|boolean, image?: string|boolean}} values
 */
async function createTenant(pool, config, values) {
  const username = requireString(values.username, '--username').trim().toLowerCase()
  const existing = await findUserByUsername(pool, username)
  if (existing) throw new Error(`username already exists: ${username}`)

  const userId = typeof values.user === 'string' ? values.user : opaqueId('usr')
  const password = typeof values.password === 'string' ? values.password : (process.env.MDSH_PASSWORD ?? randomToken(12))
  const dshImage = typeof values.image === 'string' ? values.image : config.dshImage

  await createUser(pool, { id: userId, username, passwordHash: await hashPassword(password) })
  const hostPort = await allocatePort(pool, userId)
  if (hostPort === null) throw new Error('no free tenant port in 18001-18100')

  const dataDir = join(config.dataRoot, userId, 'data')
  const envFile = join(config.tenantEnvDir, `${userId}.env`)
  try {
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      await prepareDataDir(dataDir)
    } else {
      // Unprivileged deploy (e.g. a host user with docker access): the data dir must
      // already exist and be owned by the container UID (10001).
      console.warn(`warning: unprivileged; assuming ${dataDir} exists and is owned by UID 10001`)
    }
    const tenantKey = generateTenantKey()
    await createTenantKey(pool, { id: opaqueId('key'), userId, keyHash: tenantKey.keyHash })
    await writeEnvFile(
      envFile,
      renderTenantEnv({
        userId,
        hostPort,
        dataDir,
        virtualKey: tenantKey.key,
        dshImage,
        dshVersion: config.dshVersion,
        authInternalUrl: config.authInternalUrl,
        authPublicUrl: config.authPublicUrl,
        publicOrigin: config.publicOrigin,
        tenantPath: `/u/${userId}/`,
        quotaTokens: config.quotaTokens,
        tenantCpus: config.tenantCpus,
        tenantMemory: config.tenantMemory,
      }),
    )
    await upsertInstance(pool, { userId, hostPort, status: 'pending', dshVersion: config.dshVersion || null })
    await runCompose({
      dockerBin: config.dockerBin,
      action: 'up',
      userId,
      composeFile: config.composeFile,
      envFile,
    })
    await setInstanceStatus(pool, userId, 'ready', { dshVersion: config.dshVersion || null })
    await writeAudit(pool, {
      actor: 'provisioner',
      action: 'tenant.create',
      target: userId,
      detail: { username, hostPort, image: dshImage },
    })
  } catch (error) {
    const instance = await getInstanceByUser(pool, userId).catch(() => null)
    await setInstanceStatus(pool, userId, 'failed').catch(() => {})
    const state = instance ? 'instance marked failed' : 'tenant row/port may be partially created'
    throw new Error(`${error.message}\n${userId}: ${state}; inspect logs, then run: delete --user ${userId}`)
  }

  console.log(`created ${userId} (${username})`)
  console.log(`  url:      http://127.0.0.1:${hostPort}/`)
  console.log(`  password: ${password}   (shown once)`)
  console.log(`  env file: ${envFile}`)
  console.log(`  data dir: ${dataDir}`)
}

/**
 * @param {import('pg').Pool} pool
 * @param {ReturnType<typeof loadConfig>} config
 * @param {{user?: string|boolean}} values
 */
async function deleteTenant(pool, config, values) {
  const userId = requireString(values.user, '--user')
  const user = await findUserById(pool, userId)
  if (!user) throw new Error(`unknown user: ${userId}`)
  const instance = await getInstanceByUser(pool, userId)
  if (instance) {
    const envFile = join(config.tenantEnvDir, `${userId}.env`)
    try {
      await runCompose({ dockerBin: config.dockerBin, action: 'down', userId, composeFile: config.composeFile, envFile })
    } catch (error) {
      console.warn(`warning: compose down failed, continuing: ${error.message}`)
    }
    await releasePort(pool, userId)
    await revokeTenantKeys(pool, userId)
    await setInstanceStatus(pool, userId, 'deleted')
  }
  await disableUser(pool, userId)
  await writeAudit(pool, { actor: 'provisioner', action: 'tenant.delete', target: userId })
  console.log(`deleted ${userId}; data kept at ${join(config.dataRoot, userId, 'data')} (remove manually after the retention window)`)
}

/**
 * @param {import('pg').Pool} pool
 * @param {ReturnType<typeof loadConfig>} config
 * @param {{user?: string|boolean, image?: string|boolean}} values
 */
async function rotateKey(pool, config, values) {
  const userId = requireString(values.user, '--user')
  const instance = await getInstanceByUser(pool, userId)
  if (!instance) throw new Error(`user has no instance: ${userId}`)
  await revokeTenantKeys(pool, userId)
  const tenantKey = generateTenantKey()
  await createTenantKey(pool, { id: opaqueId('key'), userId, keyHash: tenantKey.keyHash })
  const envFile = join(config.tenantEnvDir, `${userId}.env`)
  await writeEnvFile(
    envFile,
    renderTenantEnv({
      userId,
      hostPort: instance.host_port,
      dataDir: join(config.dataRoot, userId, 'data'),
      virtualKey: tenantKey.key,
      dshImage: typeof values.image === 'string' ? values.image : config.dshImage,
      dshVersion: instance.dsh_version ?? config.dshVersion,
      authInternalUrl: config.authInternalUrl,
      authPublicUrl: config.authPublicUrl,
      publicOrigin: config.publicOrigin,
      tenantPath: `/u/${userId}/`,
      quotaTokens: config.quotaTokens,
      tenantCpus: config.tenantCpus,
      tenantMemory: config.tenantMemory,
    }),
  )
  await runCompose({ dockerBin: config.dockerBin, action: 'recreate', userId, composeFile: config.composeFile, envFile })
  await setInstanceStatus(pool, userId, 'ready', { dshVersion: instance.dsh_version })
  await writeAudit(pool, { actor: 'provisioner', action: 'tenant.rotate-key', target: userId })
  console.log(`rotated key for ${userId}`)
  console.log(`  tenant key: ${tenantKey.key}   (shown once)`)
}

/**
 * @param {import('pg').Pool} pool
 * @param {{month?: string|boolean}} values
 */
async function reportUsage(pool, values) {
  const { since, until } = monthRange(typeof values.month === 'string' ? values.month : undefined)
  const rows = await usageByUserSince(pool, { since, until })
  if (rows.length === 0) {
    console.log(`no usage for ${since.toISOString().slice(0, 7)}`)
    return
  }
  console.log(`usage ${since.toISOString().slice(0, 7)} (UTC)`)
  for (const row of rows) {
    const total = Number(row.input_tokens) + Number(row.output_tokens)
    console.log(
      `${row.username}\t${row.user_id}\tin=${row.input_tokens}\tout=${row.output_tokens}`
        + `\tcache_read=${row.cache_read_tokens}\tcache_write=${row.cache_write_tokens}`
        + `\trequests=${row.requests}\ttotal=${total}`,
    )
  }
}

/**
 * @param {import('pg').Pool} pool
 */
async function reportStatus(pool) {
  const rows = await listInstances(pool)
  if (rows.length === 0) {
    console.log('no instances')
    return
  }
  for (const row of rows) {
    console.log(`${row.username}\t${row.user_id}\t:${row.host_port}\t${row.status}\t${row.dsh_version ?? '-'}`)
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      username: { type: 'string' },
      user: { type: 'string' },
      password: { type: 'string' },
      image: { type: 'string' },
      month: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const command = positionals[0]
  if (command === undefined || values.help === true) {
    console.log(HELP)
    return
  }

  const config = loadConfig()
  const pool = createPool({ connectionString: config.databaseUrl, max: 3 })
  try {
    switch (command) {
      case 'create':
        await createTenant(pool, config, values)
        break
      case 'delete':
        await deleteTenant(pool, config, values)
        break
      case 'rotate-key':
        await rotateKey(pool, config, values)
        break
      case 'usage':
        await reportUsage(pool, values)
        break
      case 'status':
        await reportStatus(pool)
        break
      default:
        throw new Error(`unknown command: ${command}\n\n${HELP}`)
    }
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(`error: ${error.message ?? error}`)
  process.exit(1)
})
