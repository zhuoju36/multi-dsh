import test from 'node:test'
import assert from 'node:assert/strict'
import { createApp, parseNext } from '../src/app.mjs'
import { sha256Hex } from '@multi-dsh/shared/ids'

const silent = { info() {}, warn() {}, error() {}, debug() {} }
const config = {
  port: 0,
  databaseUrl: 'postgres://unused',
  cookieName: 'mdsh_session',
  publicUrl: 'http://127.0.0.1:18080',
  sessionTtlMs: 3600_000,
  loginWindowMs: 300_000,
  maxLoginFailures: 5,
  secureCookie: false,
}

class MemoryStore {
  constructor({ users = [], instances = [] } = {}) {
    this.users = users
    this.instances = instances
    this.sessions = new Map()
    this.attempts = []
    this.audits = []
    this.invites = new Map()
  }

  async findUserByUsername(username) {
    return this.users.find((user) => user.username === username) ?? null
  }

  async findInstanceByPort(port) {
    return this.instances.find((instance) => instance.host_port === port) ?? null
  }

  async getInstanceByUser(userId) {
    return this.instances.find((instance) => instance.user_id === userId) ?? null
  }

  async findInviteByCodeHash(codeHash) {
    return this.invites.get(codeHash) ?? null
  }

  async registerUserWithInvite({ id, username, passwordHash, codeHash }) {
    const invite = this.invites.get(codeHash)
    const usable = invite && invite.kind === 'invite' && invite.uses < invite.max_uses
      && invite.revoked_at === null && invite.expires_at > Date.now()
    if (!usable) {
      const error = new Error('invalid invite')
      error.code = 'INVALID_INVITE'
      throw error
    }
    if (this.users.some((user) => user.username === username)) {
      const error = new Error('taken')
      error.code = 'USERNAME_TAKEN'
      throw error
    }
    const user = { id, username, password_hash: passwordHash, status: 'active' }
    this.users.push(user)
    invite.uses += 1
    return { id, username, status: 'active' }
  }

  async resetPasswordWithInvite({ codeHash, passwordHash }) {
    const invite = this.invites.get(codeHash)
    const usable = invite && invite.kind === 'reset' && invite.user_id
      && invite.uses < invite.max_uses && invite.revoked_at === null && invite.expires_at > Date.now()
    if (!usable) {
      const error = new Error('invalid invite')
      error.code = 'INVALID_INVITE'
      throw error
    }
    const user = this.users.find((candidate) => candidate.id === invite.user_id)
    user.password_hash = passwordHash
    for (const session of this.sessions.values()) {
      if (session.user_id === user.id) session.revoked = true
    }
    invite.uses += 1
    return user.id
  }

  async createSession({ idHash, userId, ttlMs }) {
    this.sessions.set(idHash, {
      user_id: userId,
      username: this.users.find((user) => user.id === userId)?.username,
      expiresAt: Date.now() + ttlMs,
      revoked: false,
    })
  }

  async findSession(idHash) {
    const session = this.sessions.get(idHash)
    if (!session || session.revoked || session.expiresAt <= Date.now()) return null
    return session
  }

  async touchSession() {}

  async revokeSession(idHash) {
    const session = this.sessions.get(idHash)
    if (session) session.revoked = true
  }

  async countRecentFailures({ username, ip, windowMs }) {
    const since = Date.now() - windowMs
    return this.attempts.filter((attempt) => attempt.username === username && attempt.ip === ip && !attempt.ok && attempt.ts > since).length
  }

  async recordLoginAttempt({ username, ip, ok }) {
    this.attempts.push({ username, ip, ok, ts: Date.now() })
  }

  async writeAudit(entry) {
    this.audits.push(entry)
  }

  async ping() {}
}

const hasher = {
  hash: async (password) => `h:${password}`,
  verify: async (digest, password) => digest === `h:${password}`,
}

function makeStore() {
  return new MemoryStore({
    users: [
      { id: 'usr_a', username: 'alice', password_hash: 'h:secret', status: 'active' },
      { id: 'usr_b', username: 'bob', password_hash: 'h:other', status: 'active' },
    ],
    instances: [
      { user_id: 'usr_a', host_port: 18001, status: 'ready' },
      { user_id: 'usr_b', host_port: 18002, status: 'ready' },
    ],
  })
}

function seedInvite(store, { kind = 'invite', code, userId = null, hours = 1, uses = 0, maxUses = 1 }) {
  store.invites.set(sha256Hex(code), {
    kind,
    user_id: userId,
    expires_at: Date.now() + hours * 3600_000,
    max_uses: maxUses,
    uses,
    revoked_at: null,
  })
}

function fakeHub(hostPort = 18001) {
  const calls = []
  return {
    calls,
    async ensure(userId) {
      calls.push(userId)
      return { host_port: hostPort, status: 'ready' }
    },
  }
}

async function makeApp(store = makeStore(), hub = undefined) {
  return createApp({ config, store, hasher, logger: silent, hub })
}

function form(fields) {
  return new URLSearchParams(fields).toString()
}

function cookieToken(response) {
  const header = response.headers['set-cookie']
  const value = Array.isArray(header) ? header[0] : header
  assert.ok(value, 'expected a Set-Cookie header')
  const match = /mdsh_session=([^;]+)/.exec(value)
  assert.ok(match, 'expected mdsh_session cookie')
  return match[1]
}

test('parseNext only accepts loopback tenant roots', () => {
  assert.deepEqual(parseNext('http://127.0.0.1:18001/'), { href: 'http://127.0.0.1:18001/', port: 18001 })
  assert.equal(parseNext('https://127.0.0.1:18001/'), null)
  assert.equal(parseNext('http://localhost:18001/'), null)
  assert.equal(parseNext('http://127.0.0.1:18001/evil'), null)
  assert.equal(parseNext('http://127.0.0.1:18001/?x=1'), null)
  assert.deepEqual(parseNext('http://127.0.0.1:18001'), { href: 'http://127.0.0.1:18001/', port: 18001 })
  assert.equal(parseNext('not a url'), null)
  assert.deepEqual(
    parseNext('http://127.0.0.1:18080/u/usr_a/', 'http://127.0.0.1:18080'),
    { href: 'http://127.0.0.1:18080/u/usr_a/', userId: 'usr_a' },
  )
  assert.equal(parseNext('http://127.0.0.1:18080/u/usr_a/extra', 'http://127.0.0.1:18080'), null)
})

test('root is a unified login page; portal login redirects to the user path', async () => {
  const app = await makeApp()
  const portal = await app.inject({ method: 'GET', url: '/' })
  assert.equal(portal.statusCode, 200)
  assert.match(portal.body, /登录 multi-dsh/)
  assert.match(portal.body, /action="\/login"/)

  const login = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ username: 'alice', password: 'secret' }),
  })
  assert.equal(login.statusCode, 303)
  assert.equal(login.headers.location, 'http://127.0.0.1:18080/u/usr_a/')

  const token = cookieToken(login)
  const root = await app.inject({ method: 'GET', url: '/', headers: { cookie: `mdsh_session=${token}` } })
  assert.equal(root.statusCode, 303)
  assert.equal(root.headers.location, 'http://127.0.0.1:18080/u/usr_a/')
  await app.close()
})

test('login form renders for a valid target and rejects an unknown one', async () => {
  const app = await makeApp()
  const ok = await app.inject({ method: 'GET', url: '/login?next=http%3A%2F%2F127.0.0.1%3A18001%2F' })
  assert.equal(ok.statusCode, 200)
  assert.match(ok.body, /name="username"/)
  assert.match(ok.body, /value="http:\/\/127\.0\.0\.1:18001\/"/)

  const evil = await app.inject({ method: 'GET', url: '/login?next=https%3A%2F%2Fevil.example%2F' })
  assert.equal(evil.statusCode, 400)

  const unknown = await app.inject({ method: 'GET', url: '/login?next=http%3A%2F%2F127.0.0.1%3A18009%2F' })
  assert.equal(unknown.statusCode, 400)
  await app.close()
})

test('successful login redirects to the tenant and introspect resolves the session', async () => {
  const store = makeStore()
  const app = await makeApp(store)
  const login = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ username: 'Alice', password: 'secret', next: 'http://127.0.0.1:18001/' }),
  })
  assert.equal(login.statusCode, 303)
  assert.equal(login.headers.location, 'http://127.0.0.1:18001/')
  const token = cookieToken(login)

  const introspect = await app.inject({ method: 'POST', url: '/introspect', payload: { session: token } })
  assert.equal(introspect.statusCode, 200)
  const body = JSON.parse(introspect.body)
  assert.equal(body.user_id, 'usr_a')
  assert.equal(body.username, 'alice')
  assert.equal(body.instance.host_port, 18001)
  assert.equal(store.audits.some((entry) => entry.action === 'login.success'), true)
  await app.close()
})

test('a user is sent to their own instance when the next target belongs to someone else', async () => {
  const app = await makeApp()
  const login = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ username: 'alice', password: 'secret', next: 'http://127.0.0.1:18002/' }),
  })
  assert.equal(login.statusCode, 303)
  assert.equal(login.headers.location, 'http://127.0.0.1:18080/u/usr_a/')
  await app.close()
})

test('wrong passwords are rejected and the account+IP is throttled after five failures', async () => {
  const store = makeStore()
  const app = await makeApp(store)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await app.inject({
      method: 'POST',
      url: '/login',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ username: 'alice', password: 'wrong', next: 'http://127.0.0.1:18001/' }),
    })
    assert.equal(response.statusCode, 401)
  }
  const blocked = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ username: 'alice', password: 'secret', next: 'http://127.0.0.1:18001/' }),
  })
  assert.equal(blocked.statusCode, 429)
  await app.close()
})

test('logout revokes the session', async () => {
  const store = makeStore()
  const app = await makeApp(store)
  const login = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ username: 'alice', password: 'secret', next: 'http://127.0.0.1:18001/' }),
  })
  const token = cookieToken(login)

  const logout = await app.inject({ method: 'GET', url: '/logout', headers: { cookie: `mdsh_session=${token}` } })
  assert.equal(logout.statusCode, 200)

  const introspect = await app.inject({ method: 'POST', url: '/introspect', payload: { session: token } })
  assert.equal(introspect.statusCode, 401)
  await app.close()
})

test('cross-origin form posts are refused', async () => {
  const app = await makeApp()
  const response = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'http://evil.example' },
    payload: form({ username: 'alice', password: 'secret', next: 'http://127.0.0.1:18001/' }),
  })
  assert.equal(response.statusCode, 403)
  await app.close()
})

test('healthz reports readiness', async () => {
  const app = await makeApp()
  const response = await app.inject({ method: 'GET', url: '/healthz' })
  assert.equal(response.statusCode, 200)
  assert.deepEqual(JSON.parse(response.body), { ok: true, service: 'auth' })
  await app.close()
})


test('invite registration creates the account and starts the instance', async () => {
  const store = makeStore()
  seedInvite(store, { code: 'inv_abcdefghijklmnop', hours: 2 })
  const hub = fakeHub(18001)
  const app = await makeApp(store, hub)

  const page = await app.inject({ method: 'GET', url: '/register?code=inv_abcdefghijklmnop' })
  assert.equal(page.statusCode, 200)
  assert.match(page.body, /name="username"/)

  const response = await app.inject({
    method: 'POST',
    url: '/register',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ username: 'carol', password: 'correct horse battery', confirm: 'correct horse battery', code: 'inv_abcdefghijklmnop' }),
  })
  assert.equal(response.statusCode, 303)
  const carol = store.users.find((user) => user.username === 'carol')
  assert.equal(response.headers.location, `http://127.0.0.1:18080/u/${carol.id}/`)
  assert.ok(response.headers['set-cookie'])
  assert.equal(store.users.some((user) => user.username === 'carol'), true)
  assert.equal(hub.calls.length, 1)
  assert.equal(store.invites.get(sha256Hex('inv_abcdefghijklmnop')).uses, 1)

  const reuse = await app.inject({
    method: 'POST',
    url: '/register',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ username: 'dave', password: 'correct horse battery', confirm: 'correct horse battery', code: 'inv_abcdefghijklmnop' }),
  })
  assert.equal(reuse.statusCode, 400)
  await app.close()
})

test('registration rejects invalid codes and taken usernames without consuming the invite', async () => {
  const store = makeStore()
  seedInvite(store, { code: 'inv_abcdefghijklmnop' })
  const hub = fakeHub()
  const app = await makeApp(store, hub)

  const invalid = await app.inject({ method: 'GET', url: '/register?code=inv_nope' })
  assert.equal(invalid.statusCode, 400)

  const taken = await app.inject({
    method: 'POST',
    url: '/register',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ username: 'alice', password: 'correct horse battery', confirm: 'correct horse battery', code: 'inv_abcdefghijklmnop' }),
  })
  assert.equal(taken.statusCode, 409)
  assert.equal(store.invites.get(sha256Hex('inv_abcdefghijklmnop')).uses, 0)
  await app.close()
})

test('reset code sets a new password and revokes old sessions', async () => {
  const store = makeStore()
  const app = await makeApp(store, fakeHub())
  const login = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ username: 'alice', password: 'secret', next: 'http://127.0.0.1:18001/' }),
  })
  assert.equal(login.statusCode, 303)
  const oldSession = cookieToken(login)

  seedInvite(store, { kind: 'reset', code: 'rst_abcdefghijklmnop', userId: 'usr_a' })
  const page = await app.inject({ method: 'GET', url: '/reset?code=rst_abcdefghijklmnop' })
  assert.equal(page.statusCode, 200)

  const reset = await app.inject({
    method: 'POST',
    url: '/reset',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ code: 'rst_abcdefghijklmnop', password: 'new password 123', confirm: 'new password 123' }),
  })
  assert.equal(reset.statusCode, 200)

  const oldLogin = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ username: 'alice', password: 'secret', next: 'http://127.0.0.1:18001/' }),
  })
  assert.equal(oldLogin.statusCode, 401)
  const newLogin = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ username: 'alice', password: 'new password 123', next: 'http://127.0.0.1:18001/' }),
  })
  assert.equal(newLogin.statusCode, 303)
  const introspect = await app.inject({ method: 'POST', url: '/introspect', payload: { session: oldSession } })
  assert.equal(introspect.statusCode, 401)
  await app.close()
})

test('login asks the hub to ensure the instance is running', async () => {
  const store = makeStore()
  const hub = fakeHub()
  const app = await makeApp(store, hub)
  const login = await app.inject({
    method: 'POST',
    url: '/login',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: form({ username: 'alice', password: 'secret', next: 'http://127.0.0.1:18001/' }),
  })
  assert.equal(login.statusCode, 303)
  assert.deepEqual(hub.calls, ['usr_a'])
  await app.close()
})
