import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createHub } from '../src/service.mjs'

const silent = { info() {}, warn() {}, error() {}, debug() {} }
const tempRoot = await mkdtemp(join(process.cwd(), '.tmp-hub-'))
after(() => rm(tempRoot, { recursive: true, force: true }))

class MemoryStore {
  constructor() {
    this.users = [{ id: 'usr_a', username: 'alice', status: 'active' }]
    this.instances = new Map()
    this.freePorts = [18001, 18002]
    this.keys = []
  }

  async findUserById(id) {
    return this.users.find((user) => user.id === id) ?? null
  }

  async getInstance(id) {
    return this.instances.get(id) ?? null
  }

  async allocatePort() {
    return this.freePorts.shift() ?? null
  }

  async createTenantKey(key) {
    this.keys.push(key)
  }

  async upsertInstance({ userId, hostPort, status, dshVersion }) {
    const row = { user_id: userId, host_port: hostPort, status, dsh_version: dshVersion ?? null }
    this.instances.set(userId, row)
    return row
  }

  async setInstanceStatus(userId, status, meta = {}) {
    const instance = this.instances.get(userId)
    if (!instance) return
    instance.status = status
    if (meta.dshVersion) instance.dsh_version = meta.dshVersion
  }

  async setInstanceStopped(userId, reason) {
    const instance = this.instances.get(userId)
    if (!instance) return
    instance.status = 'stopped'
    instance.stop_reason = reason
  }

  async listInstances() {
    return [...this.instances.values()].map((instance) => ({
      ...instance,
      username: this.users.find((user) => user.id === instance.user_id)?.username,
    }))
  }
}

function fakeSpawner() {
  const state = { status: 'exited', starts: 0, stops: 0, activity: null }
  return {
    state,
    async status() { return state.status },
    async ensureDataDir() {},
    async start() { state.starts += 1; state.status = 'running' },
    async stop() { state.stops += 1; state.status = 'exited' },
    async activity() { return state.activity },
  }
}

function makeConfig() {
  return {
    token: 'test-token',
    tenantEnvDir: join(tempRoot, 'tenants'),
    dataRoot: join(tempRoot, 'volumes'),
    dshImage: 'multi-dsh/dsh:test',
    dshVersion: '0.0.0',
    authInternalUrl: 'http://auth:18080',
    authPublicUrl: 'http://127.0.0.1:18000',
    publicOrigin: 'http://127.0.0.1:18000',
    tenantCpus: '2',
    tenantMemory: '1536m',
    idleTimeoutMs: 0,
  }
}

test('creating an instance allocates a port, writes the env file and starts it', async () => {
  const config = makeConfig()
  const store = new MemoryStore()
  const spawner = fakeSpawner()
  const hub = createHub({ config, store, spawner, logger: silent })

  const unauthorized = await hub.app.inject({ method: 'POST', url: '/internal/instances', payload: { user_id: 'usr_a' } })
  assert.equal(unauthorized.statusCode, 401)

  const response = await hub.app.inject({
    method: 'POST',
    url: '/internal/instances',
    headers: { authorization: 'Bearer test-token' },
    payload: { user_id: 'usr_a' },
  })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), { host_port: 18001, status: 'ready' })
  assert.equal(spawner.state.starts, 1)
  assert.equal(store.instances.get('usr_a').status, 'ready')
  assert.equal(store.keys.length, 1)

  const env = await readFile(join(config.tenantEnvDir, 'usr_a.env'), 'utf8')
  assert.match(env, /^USER_ID=usr_a$/m)
  assert.match(env, /^HOST_PORT=18001$/m)
  assert.match(env, /^TENANT_KEY=sk-mdsh-/m)
  assert.match(env, /^USER_HOST=127\.0\.0\.1:18000$/m)
  assert.match(env, /^TENANT_PATH=\/u\/usr_a\/$/m)
  assert.match(env, /^DSH_PUBLIC_URL=http:\/\/127\.0\.0\.1:18000\/u\/usr_a\/$/m)
  assert.match(env, /^DSH_TRUSTED_HOST=127\.0\.0\.1:18000$/m)
  await hub.app.close()
})

test('stop records the reason and status', async () => {
  const config = makeConfig()
  const store = new MemoryStore()
  const spawner = fakeSpawner()
  const hub = createHub({ config, store, spawner, logger: silent })
  await hub.app.inject({
    method: 'POST',
    url: '/internal/instances',
    headers: { authorization: 'Bearer test-token' },
    payload: { user_id: 'usr_a' },
  })
  const response = await hub.app.inject({
    method: 'POST',
    url: '/internal/instances/usr_a/stop',
    headers: { authorization: 'Bearer test-token' },
    payload: { reason: 'test' },
  })
  assert.equal(response.statusCode, 200)
  assert.equal(store.instances.get('usr_a').status, 'stopped')
  assert.equal(store.instances.get('usr_a').stop_reason, 'test')
  assert.equal(spawner.state.stops, 1)
  await hub.app.close()
})

test('idle culling stops instances with no open connections', async () => {
  const config = { ...makeConfig(), idleTimeoutMs: 60_000 }
  const store = new MemoryStore()
  const spawner = fakeSpawner()
  store.instances.set('usr_a', { user_id: 'usr_a', host_port: 18001, status: 'ready', dsh_version: '0.0.0' })
  spawner.state.status = 'running'
  spawner.state.activity = { lastActivity: new Date(Date.now() - 120_000).toISOString(), openConnections: 0 }
  const hub = createHub({ config, store, spawner, logger: silent })
  const stopped = await hub.cullOnce()
  assert.deepEqual(stopped, ['usr_a'])
  assert.equal(store.instances.get('usr_a').status, 'stopped')
  assert.equal(spawner.state.stops, 1)
  await hub.app.close()
})

test('idle culling keeps instances with open WebSocket connections', async () => {
  const config = { ...makeConfig(), idleTimeoutMs: 60_000 }
  const store = new MemoryStore()
  const spawner = fakeSpawner()
  store.instances.set('usr_a', { user_id: 'usr_a', host_port: 18001, status: 'ready' })
  spawner.state.status = 'running'
  spawner.state.activity = { lastActivity: new Date(Date.now() - 120_000).toISOString(), openConnections: 1 }
  const hub = createHub({ config, store, spawner, logger: silent })
  assert.deepEqual(await hub.cullOnce(), [])
  assert.equal(store.instances.get('usr_a').status, 'ready')
  await hub.app.close()
})

test('reconcile fixes a ready row whose container is gone', async () => {
  const config = makeConfig()
  const store = new MemoryStore()
  const spawner = fakeSpawner()
  store.instances.set('usr_a', { user_id: 'usr_a', host_port: 18001, status: 'ready' })
  spawner.state.status = 'exited'
  const hub = createHub({ config, store, spawner, logger: silent })
  await hub.reconcile()
  assert.equal(store.instances.get('usr_a').status, 'stopped')
  await hub.app.close()
})
