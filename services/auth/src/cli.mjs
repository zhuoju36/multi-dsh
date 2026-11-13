#!/usr/bin/env node
/**
 * auth-admin CLI: create invite / reset codes.
 *
 *   node services/auth/src/cli.mjs invite create [--hours 72] [--uses 1]
 *   node services/auth/src/cli.mjs reset create --username alice [--hours 24]
 */
import { existsSync, readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { createInvite, createPool, findUserByUsername } from '@multi-dsh/db'
import { opaqueId, randomToken, sha256Hex } from '@multi-dsh/shared/ids'
import { loadConfig } from './config.mjs'

const HELP = `auth-admin

commands:
  invite create [--hours 72] [--uses 1]
  reset create --username <name> [--hours 24]

env: DATABASE_URL (required)
`

/**
 * @param {string} prefix
 * @returns {string}
 */
function makeCode(prefix) {
  return `${prefix}_${randomToken(18)}`
}

/**
 * Read KEY=VALUE pairs from the platform env file (comments ignored).
 * @param {string} path
 * @returns {Record<string, string>}
 */
function readEnvFile(path) {
  if (!existsSync(path)) return {}
  const out = {}
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index < 1) continue
    out[line.slice(0, index).trim()] = line.slice(index + 1).trim()
  }
  return out
}

if (!process.env.DATABASE_URL) {
  const file = process.env.PLATFORM_ENV_FILE ?? '/srv/multi-dsh/secrets/platform.env'
  const values = readEnvFile(file)
  if (values.POSTGRES_PASSWORD) {
    const user = values.POSTGRES_USER ?? 'multi_dsh'
    const port = values.POSTGRES_PORT ?? '5432'
    const database = values.POSTGRES_DB ?? 'multi_dsh'
    process.env.DATABASE_URL = `postgres://${user}:${values.POSTGRES_PASSWORD}@127.0.0.1:${port}/${database}`
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      hours: { type: 'string' },
      uses: { type: 'string' },
      username: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  })
  const [kind, action] = positionals
  if (kind === undefined || values.help === true) {
    console.log(HELP)
    return
  }

  const config = loadConfig()
  const pool = createPool({ connectionString: config.databaseUrl, max: 1 })
  try {
    if (kind === 'invite' && (action === 'create' || action === undefined)) {
      const hours = Number(values.hours ?? 72)
      const uses = Number(values.uses ?? 1)
      const code = makeCode('inv')
      const expiresAt = new Date(Date.now() + hours * 3600_000)
      await createInvite(pool, {
        id: opaqueId('inv'),
        codeHash: sha256Hex(code),
        kind: 'invite',
        expiresAt,
        maxUses: uses,
        createdBy: process.env.USER ?? 'admin',
      })
      console.log(`invite code: ${code}`)
      console.log(`uses: ${uses}, expires: ${expiresAt.toISOString()}`)
      console.log(`register: ${config.publicUrl}/register?code=${encodeURIComponent(code)}`)
      return
    }

    if (kind === 'reset' && (action === 'create' || action === undefined)) {
      const username = typeof values.username === 'string' ? values.username.trim().toLowerCase() : ''
      if (!username) throw new Error('--username is required for reset create')
      const user = await findUserByUsername(pool, username)
      if (!user) throw new Error(`unknown user: ${username}`)
      const hours = Number(values.hours ?? 24)
      const code = makeCode('rst')
      const expiresAt = new Date(Date.now() + hours * 3600_000)
      await createInvite(pool, {
        id: opaqueId('inv'),
        codeHash: sha256Hex(code),
        kind: 'reset',
        userId: user.id,
        expiresAt,
        maxUses: 1,
        createdBy: process.env.USER ?? 'admin',
      })
      console.log(`reset code for ${username}: ${code}`)
      console.log(`expires: ${expiresAt.toISOString()}`)
      console.log(`reset: ${config.publicUrl}/reset?code=${encodeURIComponent(code)}`)
      return
    }

    throw new Error(`unknown command: ${positionals.join(' ')}\n\n${HELP}`)
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  console.error(`error: ${error.message ?? error}`)
  process.exit(1)
})
