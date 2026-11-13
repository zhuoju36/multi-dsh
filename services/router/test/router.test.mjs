import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { createRouter } from '../src/router.mjs'

const silent = { info() {}, warn() {}, error() {}, debug() {} }

/** @type {import('node:http').Server[]} */
const servers = []
after(() => {
  for (const server of servers) server.close()
})

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler)
    servers.push(server)
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

function call(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port,
      path,
      method: 'GET',
      headers: { host: 'example.test:18000', ...headers },
    }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { body += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('routes /u/<id>/ to the tenant, strips the prefix and rewrites cookies', async () => {
  const seen = {}
  const tenant = await listen((req, res) => {
    seen.path = req.url
    seen.host = req.headers.host
    res.writeHead(302, { 'set-cookie': 'dsh-auth-x=1; Path=/; HttpOnly', location: '/next' })
    res.end('tenant')
  })
  const auth = await listen((_req, res) => { res.writeHead(200); res.end('auth') })
  const router = createRouter({
    lookup: async (userId) => (userId === 'usr_a' ? { host_port: tenant.port, status: 'ready' } : null),
    authUpstream: `http://127.0.0.1:${auth.port}`,
    canonicalHost: '127.0.0.1:18000',
    logger: silent,
  })
  const front = await listen((req, res) => { router.handle(req, res) })

  const response = await call(front.port, '/u/usr_a/hello?x=1')
  assert.equal(response.status, 302)
  assert.equal(response.body, 'tenant')
  assert.equal(seen.path, '/hello?x=1')
  assert.equal(seen.host, 'example.test:18000')
  assert.deepEqual(response.headers['set-cookie'], ['dsh-auth-x=1; Path=/u/usr_a/; HttpOnly'])
  assert.equal(response.headers.location, '/u/usr_a/next')

  const bare = await call(front.port, '/u/usr_a')
  assert.equal(bare.status, 301)
  assert.equal(bare.headers.location, '/u/usr_a/')

  const unknown = await call(front.port, '/u/usr_b/')
  assert.equal(unknown.status, 404)

  const authResponse = await call(front.port, '/login?next=x')
  assert.equal(authResponse.status, 200)
  assert.equal(authResponse.body, 'auth')

  const canonical = await call(front.port, '/login', { host: 'localhost:18000' })
  assert.equal(canonical.status, 301)
  assert.equal(canonical.headers.location, 'http://127.0.0.1:18000/login')

  const health = await call(front.port, '/healthz')
  assert.equal(health.status, 200)
  assert.equal(JSON.parse(health.body).service, 'router')
})
