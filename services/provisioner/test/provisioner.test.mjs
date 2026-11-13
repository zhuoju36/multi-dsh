import test from 'node:test'
import assert from 'node:assert/strict'
import { verify } from '@node-rs/argon2'
import { generateTenantKey } from '@multi-dsh/tenant'
import { renderTenantEnv } from '@multi-dsh/tenant'
import { composeArgs } from '@multi-dsh/tenant'
import { monthRange } from '../src/usage.mjs'
import { hashPassword } from '../src/password.mjs'

test('tenant keys are prefixed, unique and hashed', () => {
  const first = generateTenantKey()
  const second = generateTenantKey()
  assert.match(first.key, /^sk-mdsh-[A-Za-z0-9_-]{32}$/)
  assert.notEqual(first.key, second.key)
  assert.match(first.keyHash, /^[0-9a-f]{64}$/)
  assert.notEqual(first.keyHash, second.keyHash)
})

test('tenant env renders the compose contract', () => {
  const env = renderTenantEnv({
    userId: 'usr_abc',
    hostPort: 18001,
    dataDir: '/srv/multi-dsh/volumes/usr_abc/data',
    virtualKey: 'sk-mdsh-test',
    dshImage: 'multi-dsh/dsh:dev',
    dshVersion: '0.2.2-rc.2',
    authInternalUrl: 'http://auth:18080',
    authPublicUrl: 'http://127.0.0.1:18080',
    quotaTokens: 1_000_000,
  })
  assert.match(env, /^USER_ID=usr_abc$/m)
  assert.match(env, /^HOST_PORT=18001$/m)
  assert.match(env, /^USER_HOST=127\.0\.0\.1:18001$/m)
  assert.match(env, /^DATA_DIR=\/srv\/multi-dsh\/volumes\/usr_abc\/data$/m)
  assert.match(env, /^TENANT_KEY=sk-mdsh-test$/m)
  assert.match(env, /^AUTH_INTERNAL_URL=http:\/\/auth:18080$/m)
  assert.match(env, /^MONTHLY_QUOTA_TOKENS=1000000$/m)
  assert.match(env, /^TENANT_MEMORY=2g$/m)
  assert.match(env, /^TENANT_CPUS=2$/m)
  assert.throws(
    () => renderTenantEnv({ ...{ userId: 'usr_abc', hostPort: 1, dataDir: 'x', virtualKey: 'k', dshImage: 'i', authInternalUrl: 'a', authPublicUrl: 'b' }, userId: 'a\nb' }),
    /contains a newline/,
  )
})

test('compose args target one project with the tenant env file', () => {
  const base = { userId: 'usr_abc', composeFile: '/repo/deploy/compose/compose.tenant.yml', envFile: '/repo/deploy/compose/tenants/usr_abc.env' }
  assert.deepEqual(composeArgs({ ...base, action: 'up' }), [
    'compose', '-p', 'dsh-usr_abc', '-f', base.composeFile, '--env-file', base.envFile, 'up', '-d', '--wait',
  ])
  assert.deepEqual(composeArgs({ ...base, action: 'down' }), [
    'compose', '-p', 'dsh-usr_abc', '-f', base.composeFile, '--env-file', base.envFile, 'down',
  ])
  assert.ok(composeArgs({ ...base, action: 'recreate' }).includes('--force-recreate'))
  assert.throws(() => composeArgs({ ...base, action: 'nope' }), /unknown compose action/)
})

test('monthRange resolves UTC months', () => {
  const explicit = monthRange('2026-11')
  assert.equal(explicit.since.toISOString(), '2026-11-01T00:00:00.000Z')
  assert.equal(explicit.until.toISOString(), '2026-12-01T00:00:00.000Z')
  const current = monthRange(undefined, new Date('2026-03-15T10:00:00Z'))
  assert.equal(current.since.toISOString(), '2026-03-01T00:00:00.000Z')
  assert.equal(current.until.toISOString(), '2026-04-01T00:00:00.000Z')
  assert.throws(() => monthRange('2026-13'), /--month must be YYYY-MM/)
  assert.throws(() => monthRange('202611'), /--month must be YYYY-MM/)
})

test('provisioner passwords are Argon2id', async () => {
  const digest = await hashPassword('correct horse battery staple')
  assert.match(digest, /^\$argon2id\$/)
  assert.equal(await verify(digest, 'correct horse battery staple'), true)
  assert.equal(await verify(digest, 'wrong'), false)
})
