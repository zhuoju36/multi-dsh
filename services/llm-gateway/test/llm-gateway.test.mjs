import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { createApp } from '../src/server.mjs'
import { sha256Hex } from '@multi-dsh/shared/ids'

const silent = { info() {}, warn() {}, error() {}, debug() {} }

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(server.address().port))
  })
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve(undefined)))
}

function call(port, { method = 'GET', path = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { text += chunk })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }))
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

async function startUpstream() {
  const requests = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body })
      const path = new URL(req.url, 'http://upstream').pathname
      if (path === '/anthropic/v1/messages') {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write('event: message_start\ndata: {"type":"message_start","message":{"model":"deepseek-v4-flash","usage":{"input_tokens":10,"cache_read_input_tokens":3,"cache_creation_input_tokens":2}}}\n\n')
        res.write('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":5}}\n\n')
        res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n')
        return
      }
      if (path === '/v1/tools/search' || path === '/v1/tools/fetch') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: path }))
        return
      }
      if (path === '/models') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ data: [] }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: path }))
    })
  })
  const port = await listen(server)
  return { server, port, requests }
}

function makeStore() {
  const usage = []
  let pendingResolve = null
  return {
    usage,
    async resolveKey(keyHash) {
      return keyHash === sha256Hex('virtual-key') ? 'usr_a' : null
    },
    async recordUsage(row) {
      usage.push(row)
      pendingResolve?.()
      pendingResolve = null
    },
    async usageForUserSince() {
      return { input_tokens: 0, output_tokens: 0 }
    },
    waitForUsage() {
      if (usage.length > 0) return Promise.resolve(usage.at(-1))
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('usage was not recorded')), 3000)
        pendingResolve = () => {
          clearTimeout(timer)
          resolve(usage.at(-1))
        }
      })
    },
  }
}

async function startGateway(upstreamPort, { quotaMonthlyTokens = 0 } = {}) {
  const config = {
    port: 0,
    databaseUrl: 'postgres://unused',
    platformApiKey: 'platform-key',
    upstreamBaseUrl: `http://127.0.0.1:${upstreamPort}/anthropic`,
    upstreamOrigin: `http://127.0.0.1:${upstreamPort}`,
    quotaMonthlyTokens,
    requestTimeoutMs: 30_000,
  }
  const store = makeStore()
  const server = createApp(config, { store, logger: silent })
  const port = await listen(server)
  return { server, port, store }
}

test('unknown routes and missing keys are refused', async (t) => {
  const upstream = await startUpstream()
  const gateway = await startGateway(upstream.port)
  t.after(async () => {
    await close(gateway.server)
    await close(upstream.server)
  })

  const unknown = await call(gateway.port, { method: 'POST', path: '/v1/chat/completions' })
  assert.equal(unknown.status, 404)
  const missing = await call(gateway.port, { method: 'POST', path: '/v1/messages' })
  assert.equal(missing.status, 401)
  const invalid = await call(gateway.port, { method: 'POST', path: '/v1/messages', headers: { 'x-api-key': 'nope' } })
  assert.equal(invalid.status, 401)
  assert.equal(upstream.requests.length, 0)
})

test('messages are proxied to the Anthropic path with the platform key and metered', async (t) => {
  const upstream = await startUpstream()
  const gateway = await startGateway(upstream.port)
  t.after(async () => {
    await close(gateway.server)
    await close(upstream.server)
  })

  const response = await call(gateway.port, {
    method: 'POST',
    path: '/v1/messages',
    headers: { 'x-api-key': 'virtual-key', 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4-flash', stream: true }),
  })
  assert.equal(response.status, 200)
  assert.match(response.body, /message_start/)

  const forwarded = upstream.requests[0]
  assert.equal(forwarded.url, '/anthropic/v1/messages')
  assert.equal(forwarded.headers['x-api-key'], 'platform-key')
  assert.equal(forwarded.headers.authorization, undefined)
  assert.equal(forwarded.headers['accept-encoding'], 'identity')

  const usage = await gateway.store.waitForUsage()
  assert.equal(usage.userId, 'usr_a')
  assert.equal(usage.kind, 'messages')
  assert.equal(usage.model, 'deepseek-v4-flash')
  assert.equal(usage.inputTokens, 10)
  assert.equal(usage.outputTokens, 5)
  assert.equal(usage.cacheReadTokens, 3)
  assert.equal(usage.cacheWriteTokens, 2)
  assert.equal(usage.status, 200)
})

test('search and fetch use Bearer auth and map to origin-level /v1/tools', async (t) => {
  const upstream = await startUpstream()
  const gateway = await startGateway(upstream.port)
  t.after(async () => {
    await close(gateway.server)
    await close(upstream.server)
  })

  const search = await call(gateway.port, {
    method: 'POST',
    path: '/v1/tools/search',
    headers: { authorization: 'Bearer virtual-key' },
    body: '{}',
  })
  assert.equal(search.status, 200)
  assert.equal(upstream.requests[0].url, '/v1/tools/search')
  assert.equal(upstream.requests[0].headers.authorization, 'Bearer platform-key')
  assert.equal(upstream.requests[0].headers['x-api-key'], undefined)

  const fetchCall = await call(gateway.port, {
    method: 'POST',
    path: '/v1/tools/fetch',
    headers: { authorization: 'Bearer virtual-key' },
    body: '{}',
  })
  assert.equal(fetchCall.status, 200)
  assert.equal(upstream.requests[1].url, '/v1/tools/fetch')
})

test('files and model listing map to their upstream paths', async (t) => {
  const upstream = await startUpstream()
  const gateway = await startGateway(upstream.port)
  t.after(async () => {
    await close(gateway.server)
    await close(upstream.server)
  })

  const file = await call(gateway.port, { method: 'POST', path: '/v1/files/abc', headers: { 'x-api-key': 'virtual-key' }, body: '' })
  assert.equal(file.status, 200)
  assert.equal(upstream.requests[0].url, '/anthropic/v1/files/abc')

  const models = await call(gateway.port, { method: 'GET', path: '/models', headers: { 'x-api-key': 'virtual-key' } })
  assert.equal(models.status, 200)
  assert.equal(upstream.requests[1].url, '/models')
})

test('the monthly quota blocks requests before reaching upstream', async (t) => {
  const upstream = await startUpstream()
  const config = {
    port: 0,
    databaseUrl: 'postgres://unused',
    platformApiKey: 'platform-key',
    upstreamBaseUrl: `http://127.0.0.1:${upstream.port}/anthropic`,
    upstreamOrigin: `http://127.0.0.1:${upstream.port}`,
    quotaMonthlyTokens: 10,
    requestTimeoutMs: 30_000,
  }
  const store = makeStore()
  store.usageForUserSince = async () => ({ input_tokens: 10, output_tokens: 0 })
  const server = createApp(config, { store, logger: silent })
  const port = await listen(server)
  t.after(async () => {
    await close(server)
    await close(upstream.server)
  })

  const response = await call(port, { method: 'POST', path: '/v1/messages', headers: { 'x-api-key': 'virtual-key' }, body: '{}' })
  assert.equal(response.status, 429)
  assert.equal(upstream.requests.length, 0)
})
