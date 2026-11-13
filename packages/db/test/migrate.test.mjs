import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { migrate } from '../../../db/migrate.mjs'

const tempRoot = await mkdtemp(join(process.cwd(), '.tmp-migrate-'))
after(() => rm(tempRoot, { recursive: true, force: true }))

class FakeClient {
  constructor() {
    /** @type {Map<string, string>} */
    this.applied = new Map()
    this.statements = []
  }

  async query(sql, params = []) {
    this.statements.push(sql)
    if (sql.includes('CREATE TABLE IF NOT EXISTS schema_migrations')) return { rows: [] }
    if (sql === 'SELECT name, checksum FROM schema_migrations') {
      return { rows: [...this.applied].map(([name, checksum]) => ({ name, checksum })) }
    }
    if (sql.startsWith('INSERT INTO schema_migrations')) {
      this.applied.set(params[0], params[1])
      return { rows: [] }
    }
    return { rows: [] }
  }
}

async function migrationDir(name, files) {
  const dir = await mkdtemp(join(tempRoot, `${name}-`))
  for (const [file, sql] of Object.entries(files)) await writeFile(join(dir, file), sql)
  return dir
}

test('applies new SQL files in filename order and is idempotent', async () => {
  const dir = await migrationDir('basic', {
    '0002_second.sql': 'CREATE TABLE second (id int);',
    '0001_first.sql': 'CREATE TABLE first (id int);',
  })
  const client = new FakeClient()
  assert.deepEqual(await migrate(client, dir), ['0001_first.sql', '0002_second.sql'])
  assert.deepEqual(await migrate(client, dir), [])
  assert.deepEqual([...client.applied.keys()], ['0001_first.sql', '0002_second.sql'])
})

test('rejects a changed migration that was already applied', async () => {
  const dir = await migrationDir('changed', { '0001_first.sql': 'CREATE TABLE first (id int);' })
  const client = new FakeClient()
  await migrate(client, dir)
  await writeFile(join(dir, '0001_first.sql'), 'CREATE TABLE first (id bigint);')
  await assert.rejects(migrate(client, dir), /changed after it was applied/)
})

test('runs each migration inside a transaction', async () => {
  const dir = await migrationDir('tx', { '0001_first.sql': 'CREATE TABLE first (id int);' })
  const client = new FakeClient()
  await migrate(client, dir)
  assert.ok(client.statements.includes('BEGIN'))
  assert.ok(client.statements.includes('COMMIT'))
})
