#!/usr/bin/env node
/**
 * Apply plain-SQL migrations in filename order, recording a checksum per file.
 * A migration already applied with different content fails instead of reapplying.
 */
import { readdir, readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MIGRATIONS_DIR = join(HERE, 'migrations')

/**
 * @param {{query: Function}} client
 * @param {string} [dir]
 * @returns {Promise<string[]>} files applied by this run
 */
export async function migrate(client, dir = MIGRATIONS_DIR) {
  await client.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
  )
  const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort()
  const applied = new Map(
    (await client.query('SELECT name, checksum FROM schema_migrations')).rows.map((row) => [row.name, row.checksum]),
  )
  const appliedNow = []
  for (const file of files) {
    const sql = await readFile(join(dir, file), 'utf8')
    const checksum = createHash('sha256').update(sql).digest('hex')
    if (applied.has(file)) {
      if (applied.get(file) !== checksum) {
        throw new Error(`migration ${file} changed after it was applied; add a new migration instead`)
      }
      continue
    }
    await client.query('BEGIN')
    try {
      await client.query(sql)
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum])
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
    appliedNow.push(file)
  }
  return appliedNow
}

async function main() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) {
    console.error('DATABASE_URL is required')
    process.exit(1)
  }
  const { createPool } = await import('../packages/db/src/index.mjs')
  const pool = createPool({ connectionString, max: 1 })
  const client = await pool.connect()
  try {
    const applied = await migrate(client)
    console.log(applied.length === 0 ? 'schema up to date' : `applied: ${applied.join(', ')}`)
  } finally {
    client.release()
    await pool.end()
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main().catch((error) => {
    console.error(error.message ?? error)
    process.exit(1)
  })
}
