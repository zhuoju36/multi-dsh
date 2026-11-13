#!/usr/bin/env node
/**
 * multi-dsh gateway (prototype)
 *
 * Sits in front of a loopback-bound `dsh web` and makes a platform-authenticated
 * browser look like a DSH-authenticated browser:
 *
 *   1. verify the platform session (auth /introspect) and that it belongs to THIS tenant
 *   2. on first use, exchange the DSH launch token for a signed DSH cookie
 *   3. reverse-proxy to 127.0.0.1:3080, preserving Host and passing WebSocket upgrades
 *
 * Env:
 *   LISTEN_PORT   default 8080
 *   DSH_HOST      default 127.0.0.1
 *   DSH_PORT      default 3080
 *   TENANT_ID     required in auth mode; default 'dev'
 *   USER_HOST     public authority, e.g. 127.0.0.1:18001
 *   AUTH_URL      e.g. http://auth:18080 ; unset = dev mode (no platform auth)
 *   AUTH_COOKIE   default mdsh_session
 *   TOKEN_FILE    default /run/dsh/launch-token
 */
import { createServer, request } from 'node:http'
import { connect } from 'node:net'
import { readFile } from 'node:fs/promises'

const env = process.env
const LISTEN_PORT = Number(env.LISTEN_PORT ?? 8080)
const DSH_HOST = env.DSH_HOST ?? '127.0.0.1'
const DSH_PORT = Number(env.DSH_PORT ?? 3080)
const TENANT_ID = env.TENANT_ID ?? 'dev'
const USER_HOST = env.USER_HOST ?? `127.0.0.1:${LISTEN_PORT}`
const AUTH_URL = (env.AUTH_URL ?? '').replace(/\/+$/, '')
const AUTH_COOKIE = env.AUTH_COOKIE ?? 'mdsh_session'
const TOKEN_FILE = env.TOKEN_FILE ?? '/run/dsh/launch-token'
const AUTH_TTL_MS = 30_000
const COOKIE_TTL_MS = 6 * 3600_000

/** @type {Map<string, {cookie: string, expiresAt: number}>} */
const dshCookies = new Map()
/** @type {Map<string, {userId: string, expiresAt: number}>} */
const authCache = new Map()

function log(fields) {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...fields }))
}

function parseCookies(header) {
  const out = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const name = part.slice(0, i).trim()
    if (name) out[name] = part.slice(i + 1).trim()
  }
  return out
}

function loginUrl() {
  return `${AUTH_URL}/login?next=${encodeURIComponent(`http://${USER_HOST}/`)}`
}

async function introspect(session) {
  const cached = authCache.get(session)
  if (cached && cached.expiresAt > Date.now()) return cached.userId
  try {
    const res = await fetch(`${AUTH_URL}/introspect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ session }),
      signal: AbortSignal.timeout(3000),
    })
    if (res.status === 401) return null
    if (!res.ok) return undefined
    const body = await res.json()
    if (typeof body?.user_id !== 'string') return undefined
    authCache.set(session, { userId: body.user_id, expiresAt: Date.now() + AUTH_TTL_MS })
    return body.user_id
  } catch {
    return undefined
  }
}

/** @returns {Promise<{session: string} | {redirect: string} | {status: number}>} */
async function authorize(req) {
  const session = parseCookies(req.headers.cookie)[AUTH_COOKIE]
  if (!AUTH_URL) return { session: 'dev' }
  if (!session) return { redirect: loginUrl() }
  const userId = await introspect(session)
  if (userId === null) return { redirect: loginUrl() }
  if (userId === undefined) return { status: 503 }
  if (userId !== TENANT_ID) return { status: 403 }
  return { session }
}

function dshCookieFor(session) {
  const hit = dshCookies.get(session)
  return hit && hit.expiresAt > Date.now() ? hit.cookie : undefined
}

async function exchangeToken(hostHeader, session) {
  let raw
  try {
    raw = await readFile(TOKEN_FILE, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return 'not-ready'
    throw err
  }
  const token = raw.trim()
  if (!token) return 'not-ready'
  // Must use http.request: fetch() ignores a custom Host header (forbidden header),
  // and DSH binds the signed cookie to the Host it receives.
  const setCookies = await new Promise((resolve, reject) => {
    const up = request(
      {
        host: DSH_HOST,
        port: DSH_PORT,
        method: 'GET',
        path: `/?token=${encodeURIComponent(token)}`,
        headers: { host: hostHeader },
      },
      (res) => {
        res.resume()
        const cookies = res.headers['set-cookie']
        resolve(cookies ?? [])
      },
    )
    up.on('error', reject)
    up.setTimeout(5000, () => up.destroy(new Error('token exchange timeout')))
    up.end()
  })
  if (setCookies.length === 0) return 'failed'
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ')
  dshCookies.set(session, { cookie, expiresAt: Date.now() + COOKIE_TTL_MS })
  log({ event: 'token-exchanged', tenant: TENANT_ID, host: hostHeader })
  return setCookies
}

function hostHeader(req) {
  return req.headers.host ?? USER_HOST
}

function incomingHeaders(req, dshCookie) {
  const headers = { ...req.headers }
  headers.host = hostHeader(req)
  if (dshCookie) headers.cookie = req.headers.cookie ? `${req.headers.cookie}; ${dshCookie}` : dshCookie
  return headers
}

function replyRedirect(res, setCookies, reqUrl) {
  // DSH accepts the token exchange only at the application root; deep links
  // land on the SPA root after the cookie is installed.
  const location = reqUrl === '/' ? './' : '/'
  const headers = { location, 'cache-control': 'no-store' }
  if (setCookies) headers['set-cookie'] = setCookies
  res.writeHead(303, headers)
  res.end()
}

async function handle(req, res) {
  if (req.url === '/healthz') {
    const ok = await new Promise((resolve) => {
      const sock = connect(DSH_PORT, DSH_HOST)
      sock.once('connect', () => { sock.destroy(); resolve(true) })
      sock.once('error', () => resolve(false))
      sock.setTimeout(1000, () => { sock.destroy(); resolve(false) })
    })
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok }))
    return
  }

  const auth = await authorize(req)
  if (auth.redirect) {
    res.writeHead(303, { location: auth.redirect, 'cache-control': 'no-store' })
    res.end()
    return
  }
  if (auth.status) {
    res.writeHead(auth.status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: auth.status === 403 ? 'tenant mismatch' : 'auth unavailable' }))
    return
  }

  if (!dshCookieFor(auth.session)) {
    let setCookies
    try {
      setCookies = await exchangeToken(hostHeader(req), auth.session)
    } catch (err) {
      log({ event: 'token-exchange-error', tenant: TENANT_ID, message: String(err?.message ?? err) })
      setCookies = 'failed'
    }
    if (setCookies === 'not-ready') {
      res.writeHead(503, { 'retry-after': '2', 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'instance starting' }))
      return
    }
    if (setCookies === 'failed') {
      log({ event: 'token-exchange-failed', tenant: TENANT_ID })
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'token exchange failed' }))
      return
    }
    replyRedirect(res, setCookies, req.url)
    return
  }

  forward(req, res, auth.session, false)
}

function forward(req, res, session, isRetry) {
  const upstream = request(
    {
      host: DSH_HOST,
      port: DSH_PORT,
      method: req.method,
      path: req.url,
      headers: incomingHeaders(req, dshCookieFor(session)),
    },
    (upres) => {
      if (upres.statusCode === 401 && !isRetry) {
        upres.resume()
        dshCookies.delete(session)
        res.writeHead(303, { location: './', 'cache-control': 'no-store' })
        res.end()
        return
      }
      res.writeHead(upres.statusCode ?? 502, upres.headers)
      upres.pipe(res)
    },
  )
  upstream.on('error', (err) => {
    log({ event: 'proxy-error', tenant: TENANT_ID, message: String(err?.message ?? err) })
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'bad gateway' }))
  })
  req.pipe(upstream)
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    log({ event: 'request-error', tenant: TENANT_ID, message: String(err?.message ?? err) })
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'internal' }))
  })
})

server.on('upgrade', async (req, socket, head) => {
  try {
    const auth = await authorize(req)
    if (auth.redirect || auth.status) {
      socket.write(`HTTP/1.1 ${auth.status ?? 303} ${auth.redirect ? 'See Other' : ''}\r\nConnection: close\r\n\r\n`)
      socket.destroy()
      return
    }
    if (!dshCookieFor(auth.session)) {
      const setCookies = await exchangeToken(hostHeader(req), auth.session).catch(() => 'failed')
      if (setCookies === 'not-ready' || setCookies === 'failed') {
        socket.write('HTTP/1.1 503 Service Unavailable\r\nRetry-After: 2\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
    }
    const upstream = connect(DSH_PORT, DSH_HOST, () => {
      const headers = incomingHeaders(req, dshCookieFor(auth.session))
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (const [name, value] of Object.entries(headers)) {
        for (const v of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${v}`)
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head?.length) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  } catch (err) {
    log({ event: 'upgrade-error', tenant: TENANT_ID, message: String(err?.message ?? err) })
    socket.destroy()
  }
})

server.listen(LISTEN_PORT, '0.0.0.0', () => {
  log({ event: 'listening', port: LISTEN_PORT, tenant: TENANT_ID, dsh: `http://${DSH_HOST}:${DSH_PORT}`, auth: AUTH_URL || 'dev-mode' })
})

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log({ event: 'shutdown', signal })
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 3000).unref()
  })
}
