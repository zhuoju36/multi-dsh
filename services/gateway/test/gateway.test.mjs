import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createApp } from '../server.mjs'
import { createLogger } from '../../../packages/shared/src/logger.mjs'

const silent = createLogger({ service: 'test', level: 'error', sink: { write() {} } })
// Never use os.tmpdir(): the sandbox may point TMPDIR at a read-only path.
const tempRoot = await mkdtemp(join(process.cwd(), '.tmp-gateway-'))
after(() => rm(tempRoot, { recursive: true, force: true }))

/** @param {import('node:http').Server} server */
function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

/** @param {import('node:http').Server} server */
function close(server) {
  return new Promise((resolve) => server.close(() => resolve(undefined)))
}

/**
 * @param {number} port
 * @param {{method?: string, path?: string, headers?: Record<string, string>}} [options]
 */
function call(port, { method = 'GET', path = '/', headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

async function startFakeDsh() {
  const state = { exchanges: 0, lastCookie: undefined, upgradeCookie: undefined }
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh')
    if (url.pathname === '/' && url.searchParams.has('token')) {
      state.exchanges += 1
      res.writeHead(303, { location: './', 'set-cookie': ['dsh-auth-test=v1; Path=/; HttpOnly'] })
      res.end()
      return
    }
    state.lastCookie = req.headers.cookie
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('dsh-ok')
  })
  server.on('upgrade', (req, socket) => {
    state.upgradeCookie = req.headers.cookie
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    socket.end()
  })
  const port = await listen(server)
  return { server, port, state }
}

async function startFakeAuth(userId = 'usr_a') {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/introspect') {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}')
        if (parsed.session === 'good') {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ user_id: userId }))
        } else {
          res.writeHead(401)
          res.end('unauthorized')
        }
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  const port = await listen(server)
  return { server, port }
}

async function startGateway({ tenantId = 'usr_a', authPort, dshPort, devMode = false, maxClientBodyBytes = 1024, tenantPath = '/' }) {
  const dir = await mkdtemp(join(tempRoot, 'gw-'))
  const tokenFile = join(dir, 'token')
  await writeFile(tokenFile, 'launch-token')
  const config = {
    listenPort: 0,
    dshHost: '127.0.0.1',
    dshPort,
    tenantId,
    userHost: '127.0.0.1:18001',
    tenantPath,
    tokenFile,
    authCookie: 'mdsh_session',
    authInternalUrl: `http://127.0.0.1:${authPort}`,
    authPublicUrl: 'http://127.0.0.1:18080',
    authCacheMs: 30_000,
    dshCookieTtlMs: 60_000,
    maxClientBodyBytes,
    devMode,
  }
  const server = createApp(config, { logger: silent })
  const port = await listen(server)
  return { server, port, config }
}

function upgrade(port, headers) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path: '/api/remote.mux',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
        ...headers,
      },
    })
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve(res.statusCode)
    })
    req.on('response', (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', reject)
    req.end()
  })
}

test('redirects to login, then exchanges the token once and strips the platform cookie', async (t) => {
  const dsh = await startFakeDsh()
  const auth = await startFakeAuth('usr_a')
  const gateway = await startGateway({ authPort: auth.port, dshPort: dsh.port, maxClientBodyBytes: 10_000 })
  t.after(async () => {
    await close(gateway.server)
    await close(auth.server)
    await close(dsh.server)
  })

  const anonymous = await call(gateway.port)
  assert.equal(anonymous.status, 303)
  assert.match(String(anonymous.headers.location), /\/login\?next=http%3A%2F%2F127\.0\.0\.1%3A18001%2F$/)

  const exchange = await call(gateway.port, { headers: { cookie: 'mdsh_session=good' } })
  assert.equal(exchange.status, 303)
  assert.match(String(exchange.headers['set-cookie'][0]), /^dsh-auth-test=v1/)

  const proxied = await call(gateway.port, { headers: { cookie: 'mdsh_session=good' } })
  assert.equal(proxied.status, 200)
  assert.equal(proxied.body, 'dsh-ok')
  assert.equal(dsh.state.exchanges, 1, 'token exchange happens once per platform session')
  assert.equal(dsh.state.lastCookie, 'dsh-auth-test=v1', 'platform cookie is not forwarded to DSH')

  const health = await call(gateway.port, { path: '/healthz' })
  assert.equal(health.status, 200)
  assert.deepEqual(JSON.parse(health.body), { ok: true })
})

test('deep-path token exchange redirects to the application root', async (t) => {
  const dsh = await startFakeDsh()
  const auth = await startFakeAuth('usr_a')
  const gateway = await startGateway({ authPort: auth.port, dshPort: dsh.port })
  t.after(async () => {
    await close(gateway.server)
    await close(auth.server)
    await close(dsh.server)
  })
  const response = await call(gateway.port, { path: '/api/remote.mux', headers: { cookie: 'mdsh_session=good' } })
  assert.equal(response.status, 303)
  assert.equal(response.headers.location, '/')
})

test('reports gateway activity for the idle culler', async (t) => {
  const dsh = await startFakeDsh()
  const gateway = await startGateway({ authPort: 1, dshPort: dsh.port, devMode: true })
  t.after(async () => {
    await close(gateway.server)
    await close(dsh.server)
  })
  const response = await call(gateway.port, { path: '/internal/activity' })
  assert.equal(response.status, 200)
  const activity = JSON.parse(response.body)
  assert.equal(typeof activity.lastActivity, 'string')
  assert.equal(activity.openConnections, 0)
})

test('login URL carries the public path prefix', async (t) => {
  const dsh = await startFakeDsh()
  const gateway = await startGateway({ authPort: 1, dshPort: dsh.port, devMode: false, tenantPath: '/u/usr_a/' })
  t.after(async () => {
    await close(gateway.server)
    await close(dsh.server)
  })
  const response = await call(gateway.port, { path: '/' })
  assert.equal(response.status, 303)
  assert.equal(
    response.headers.location,
    'http://127.0.0.1:18080/login?next=http%3A%2F%2F127.0.0.1%3A18001%2Fu%2Fusr_a%2F',
  )
})

test('rejects a session that belongs to another tenant', async (t) => {
  const dsh = await startFakeDsh()
  const auth = await startFakeAuth('usr_b')
  const gateway = await startGateway({ authPort: auth.port, dshPort: dsh.port })
  t.after(async () => {
    await close(gateway.server)
    await close(auth.server)
    await close(dsh.server)
  })
  const response = await call(gateway.port, { headers: { cookie: 'mdsh_session=good' } })
  assert.equal(response.status, 403)
})

test('returns 503 when the auth service is unreachable', async (t) => {
  const dsh = await startFakeDsh()
  const gateway = await startGateway({ authPort: 1, dshPort: dsh.port })
  t.after(async () => {
    await close(gateway.server)
    await close(dsh.server)
  })
  const response = await call(gateway.port, { headers: { cookie: 'mdsh_session=good' } })
  assert.equal(response.status, 503)
})

test('rejects oversized uploads early', async (t) => {
  const dsh = await startFakeDsh()
  const auth = await startFakeAuth('usr_a')
  const gateway = await startGateway({ authPort: auth.port, dshPort: dsh.port, maxClientBodyBytes: 10 })
  t.after(async () => {
    await close(gateway.server)
    await close(auth.server)
    await close(dsh.server)
  })
  const response = await call(gateway.port, {
    method: 'POST',
    path: '/api/upload',
    headers: { cookie: 'mdsh_session=good', 'content-length': '11' },
  })
  assert.equal(response.status, 413)
})

test('proxies websocket upgrades after exchange', async (t) => {
  const dsh = await startFakeDsh()
  const auth = await startFakeAuth('usr_a')
  const gateway = await startGateway({ authPort: auth.port, dshPort: dsh.port })
  t.after(async () => {
    await close(gateway.server)
    await close(auth.server)
    await close(dsh.server)
  })
  await call(gateway.port, { headers: { cookie: 'mdsh_session=good' } })
  const status = await upgrade(gateway.port, { cookie: 'mdsh_session=good' })
  assert.equal(status, 101)
  assert.equal(dsh.state.upgradeCookie, 'dsh-auth-test=v1')
})

test('dev mode proxies without platform auth', async (t) => {
  const dsh = await startFakeDsh()
  const gateway = await startGateway({ authPort: 1, dshPort: dsh.port, devMode: true })
  t.after(async () => {
    await close(gateway.server)
    await close(dsh.server)
  })
  const exchange = await call(gateway.port)
  assert.equal(exchange.status, 303)
  const proxied = await call(gateway.port)
  assert.equal(proxied.status, 200)
  assert.equal(dsh.state.exchanges, 1)
})
