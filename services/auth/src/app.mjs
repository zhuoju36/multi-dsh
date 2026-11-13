/** Auth HTTP app: login, invite registration, password reset, sessions, introspection. */
import Fastify from 'fastify'
import { parseCookies, serializeCookie } from '@multi-dsh/shared/cookies'
import { opaqueId, randomToken, sha256Hex } from '@multi-dsh/shared/ids'
import { loginPage, messagePage, registerPage, resetPage } from './pages.mjs'

export const MIN_PASSWORD_LENGTH = 12
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_-]{2,31}$/
const INVITE_PATTERN = /^(inv|rst)_[A-Za-z0-9_-]{10,}$/

/**
 * Parse and validate a post-login target. Only the loopback tenant URLs issued by
 * the registry are accepted (no open redirect).
 * @param {string} raw
 * @returns {{href: string, port: number} | null}
 */
export function parseNext(raw, publicOrigin = 'http://127.0.0.1:18000') {
  if (typeof raw !== 'string' || raw === '') return null
  let url
  let base
  try {
    url = new URL(raw)
    base = new URL(publicOrigin)
  } catch {
    return null
  }
  if (url.protocol !== 'http:') return null

  // Path-prefix form: http://<public-origin>/u/<user-id>/
  if (url.origin === base.origin) {
    const match = /^\/u\/(usr_[A-Za-z0-9]+)\/$/.exec(url.pathname)
    if (!match || url.search !== '' || url.hash !== '') return null
    return { href: `${base.origin}/u/${match[1]}/`, userId: match[1] }
  }

  // Legacy port form, kept for old bookmarks during migration.
  if (url.hostname !== '127.0.0.1') return null
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return null
  const port = Number(url.port)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null
  return { href: `http://127.0.0.1:${port}/`, port }
}

/**
 * @param {string} password
 * @returns {string | null}
 */
export function passwordProblem(password) {
  if (password.length < MIN_PASSWORD_LENGTH) return `密码至少 ${MIN_PASSWORD_LENGTH} 位`
  if (password.length > 200) return '密码过长'
  return null
}

/**
 * @param {{config: object, store: any, hasher: {hash: Function, verify: Function}, logger: any, hub?: any}} deps
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
export async function createApp({ config, store, hasher, logger, hub }) {
  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 })
  // Equalize timing between "unknown user" and "wrong password".
  const dummyHash = await hasher.hash('multi-dsh-invalid-password')
  /** @type {Map<string, {count: number, resetAt: number}>} */
  const registrationHits = new Map()

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    try {
      done(null, Object.fromEntries(new URLSearchParams(body)))
    } catch (error) {
      done(error)
    }
  })

  /**
   * @param {import('fastify').FastifyRequest} request
   * @returns {Promise<{token: string, row: any} | null>}
   */
  async function sessionFromRequest(request) {
    const token = parseCookies(request.headers.cookie)[config.cookieName]
    if (!token) return null
    const row = await store.findSession(sha256Hex(token))
    return row ? { token, row } : null
  }

  /**
   * @param {string} raw
   */
  async function resolveTarget(raw) {
    const target = parseNext(raw, config.publicUrl)
    if (!target) return null
    if (target.userId) {
      const instance = await store.getInstanceByUser(target.userId)
      return instance && instance.status !== 'deleted' ? target : null
    }
    const instance = await store.findInstanceByPort(target.port)
    return instance ? { ...target, userId: instance.user_id } : null
  }

  /**
   * @param {import('fastify').FastifyReply} reply
   * @param {string} userId
   * @param {{href: string, port: number}} target
   */
  async function redirectForUser(reply, userId, target) {
    const instance = await store.getInstanceByUser(userId)
    if (!instance) {
      return reply
        .code(403)
        .type('text/html')
        .send(messagePage({ title: '没有可用实例', message: '账号已登录，但尚未开通实例，请联系管理员。' }))
    }
    const href = target && target.userId === userId ? target.href : `${config.publicUrl}/u/${userId}/`
    return reply.code(303).header('location', href).send()
  }

  /**
   * @param {import('fastify').FastifyRequest} request
   * @returns {boolean}
   */
  function sameOrigin(request) {
    const origin = request.headers.origin
    if (origin === undefined) return true
    return origin === config.publicUrl
  }

  function audit(entry) {
    store.writeAudit(entry).catch((error) => {
      logger.warn({ event: 'audit-failed', message: String(error?.message ?? error) })
    })
  }

  /**
   * @param {string | undefined} ip
   * @returns {boolean}
   */
  function allowRegistration(ip) {
    const key = ip ?? 'unknown'
    const now = Date.now()
    const hit = registrationHits.get(key)
    if (!hit || hit.resetAt <= now) {
      registrationHits.set(key, { count: 1, resetAt: now + config.loginWindowMs })
      return true
    }
    if (hit.count >= 10) return false
    hit.count += 1
    return true
  }

  /**
   * @param {unknown} raw
   * @param {'invite' | 'reset'} kind
   * @returns {Promise<any | null>}
   */
  async function inspectInvite(raw, kind) {
    if (typeof raw !== 'string' || !INVITE_PATTERN.test(raw)) return null
    const invite = await store.findInviteByCodeHash(sha256Hex(raw))
    if (!invite || invite.kind !== kind) return null
    if (invite.revoked_at !== null && invite.revoked_at !== undefined) return null
    if (Number(invite.uses) >= Number(invite.max_uses)) return null
    if (new Date(invite.expires_at).getTime() <= Date.now()) return null
    return invite
  }

  /**
   * @param {import('fastify').FastifyReply} reply
   * @param {string} userId
   * @param {string} username
   * @returns {Promise<string>} tenant URL
   */
  async function ensureInstanceFor(userId, username) {
    if (!hub) throw Object.assign(new Error('hub unavailable'), { statusCode: 503 })
    try {
      const result = await hub.ensure(userId)
      if (!result || typeof result.host_port !== 'number') throw new Error('hub did not return a port')
      return `http://127.0.0.1:${result.host_port}/`
    } catch (error) {
      logger.error({ event: 'hub-ensure-failed', userId, username, message: String(error?.message ?? error) })
      throw error
    }
  }

  app.get('/', async (request, reply) => {
    const current = await sessionFromRequest(request)
    if (current) return redirectForUser(reply, current.row.user_id, null)
    return reply.type('text/html').send(loginPage({ next: '' }))
  })

  app.get('/login', async (request, reply) => {
    const rawNext = typeof request.query?.next === 'string' ? request.query.next : ''
    const target = rawNext === '' ? null : await resolveTarget(rawNext)
    if (rawNext !== '' && !target) {
      return reply
        .code(400)
        .type('text/html')
        .send(messagePage({
          title: '登录链接无效',
          message: '链接不存在或已失效。',
          link: { href: '/', text: '返回统一登录' },
        }))
    }
    const current = await sessionFromRequest(request)
    if (current) return redirectForUser(reply, current.row.user_id, target)
    return reply.type('text/html').send(loginPage({ next: target?.href ?? '' }))
  })

  app.post('/login', async (request, reply) => {
    if (!sameOrigin(request)) {
      return reply.code(403).type('text/html').send(messagePage({ title: '请求被拒绝', message: '来源校验失败。' }))
    }
    const body = /** @type {Record<string, unknown>} */ (request.body ?? {})
    const rawNext = typeof body.next === 'string' ? body.next : ''
    const target = rawNext === '' ? null : await resolveTarget(rawNext)
    if (rawNext !== '' && !target) {
      return reply
        .code(400)
        .type('text/html')
        .send(messagePage({
          title: '登录链接无效',
          message: '链接不存在或已失效。',
          link: { href: '/', text: '返回统一登录' },
        }))
    }
    const username = (typeof body.username === 'string' ? body.username : '').trim().toLowerCase()
    const password = typeof body.password === 'string' ? body.password : ''
    if (!username || !password) {
      return reply.code(400).type('text/html').send(loginPage({ next: rawNext, error: '请输入用户名和密码' }))
    }

    const ip = request.ip ?? null
    const failures = await store.countRecentFailures({ username, ip, windowMs: config.loginWindowMs })
    if (failures >= config.maxLoginFailures) {
      audit({ action: 'login.throttled', target: username, ip })
      return reply
        .code(429)
        .type('text/html')
        .send(messagePage({ title: '尝试次数过多', message: '请等待 5 分钟后再试。' }))
    }

    const user = await store.findUserByUsername(username)
    const ok = user ? await hasher.verify(user.password_hash, password) : await hasher.verify(dummyHash, password)
    await store.recordLoginAttempt({ username, ip, ok: Boolean(user && ok) })
    audit({ action: user && ok ? 'login.success' : 'login.failure', target: username, ip })

    if (!user || !ok) {
      return reply
        .code(401)
        .type('text/html')
        .send(loginPage({ next: rawNext, error: '用户名或密码错误', username }))
    }

    // Start a stopped instance before the browser follows the redirect. A Hub
    // failure does not block login; the following request may still find it running.
    if (hub) {
      try {
        await hub.ensure(user.id)
      } catch (error) {
        logger.warn({ event: 'login-ensure-failed', userId: user.id, message: String(error?.message ?? error) })
      }
    }

    const token = randomToken()
    await store.createSession({ idHash: sha256Hex(token), userId: user.id, ttlMs: config.sessionTtlMs })
    reply.header(
      'set-cookie',
      serializeCookie(config.cookieName, token, {
        maxAge: Math.floor(config.sessionTtlMs / 1000),
        secure: config.secureCookie,
      }),
    )
    return redirectForUser(reply, user.id, target)
  })

  app.get('/register', async (request, reply) => {
    const code = typeof request.query?.code === 'string' ? request.query.code : ''
    if (!await inspectInvite(code, 'invite')) {
      return reply
        .code(400)
        .type('text/html')
        .send(messagePage({ title: '邀请码无效', message: '邀请码不存在、已使用或已过期，请联系管理员。' }))
    }
    return reply.type('text/html').send(registerPage({ code }))
  })

  app.post('/register', async (request, reply) => {
    if (!sameOrigin(request)) {
      return reply.code(403).type('text/html').send(messagePage({ title: '请求被拒绝', message: '来源校验失败。' }))
    }
    if (!allowRegistration(request.ip ?? null)) {
      return reply.code(429).type('text/html').send(messagePage({ title: '操作过于频繁', message: '请稍后再试。' }))
    }
    const body = /** @type {Record<string, unknown>} */ (request.body ?? {})
    const code = typeof body.code === 'string' ? body.code : ''
    const username = (typeof body.username === 'string' ? body.username : '').trim().toLowerCase()
    const password = typeof body.password === 'string' ? body.password : ''
    const confirm = typeof body.confirm === 'string' ? body.confirm : ''

    if (!await inspectInvite(code, 'invite')) {
      return reply
        .code(400)
        .type('text/html')
        .send(messagePage({ title: '邀请码无效', message: '邀请码不存在、已使用或已过期，请联系管理员。' }))
    }
    const error = !USERNAME_PATTERN.test(username)
      ? '用户名需为 3-32 位小写字母/数字/下划线/中划线，且以字母或数字开头'
      : passwordProblem(password) ?? (password !== confirm ? '两次输入的密码不一致' : null)
    if (error) {
      return reply.code(400).type('text/html').send(registerPage({ code, error, username }))
    }

    let user
    try {
      user = await store.registerUserWithInvite({
        id: opaqueId('usr'),
        username,
        passwordHash: await hasher.hash(password),
        codeHash: sha256Hex(code),
      })
    } catch (err) {
      if (err?.code === 'USERNAME_TAKEN') {
        return reply.code(409).type('text/html').send(registerPage({ code, error: '用户名已被占用', username }))
      }
      if (err?.code === 'INVALID_INVITE') {
        return reply
          .code(400)
          .type('text/html')
          .send(messagePage({ title: '邀请码无效', message: '邀请码刚刚被使用或已过期，请联系管理员。' }))
      }
      throw err
    }

    let tenantUrl
    try {
      await ensureInstanceFor(user.id, user.username)
      tenantUrl = `${config.publicUrl}/u/${user.id}/`
    } catch (error) {
      audit({ action: 'register.instance-failed', target: user.id, ip: request.ip ?? null })
      return reply
        .code(error?.statusCode === 503 ? 503 : 502)
        .type('text/html')
        .send(messagePage({ title: '账号已创建，实例启动失败', message: '账号已创建，但实例启动失败，请联系管理员处理。' }))
    }
    audit({ action: 'register.success', target: user.id, ip: request.ip ?? null, detail: { username } })

    const token = randomToken()
    await store.createSession({ idHash: sha256Hex(token), userId: user.id, ttlMs: config.sessionTtlMs })
    reply.header(
      'set-cookie',
      serializeCookie(config.cookieName, token, {
        maxAge: Math.floor(config.sessionTtlMs / 1000),
        secure: config.secureCookie,
      }),
    )
    return reply.code(303).header('location', tenantUrl).send()
  })

  app.get('/reset', async (request, reply) => {
    const code = typeof request.query?.code === 'string' ? request.query.code : ''
    if (!await inspectInvite(code, 'reset')) {
      return reply
        .code(400)
        .type('text/html')
        .send(messagePage({ title: '重置链接无效', message: '重置链接不存在、已使用或已过期，请联系管理员。' }))
    }
    return reply.type('text/html').send(resetPage({ code }))
  })

  app.post('/reset', async (request, reply) => {
    if (!sameOrigin(request)) {
      return reply.code(403).type('text/html').send(messagePage({ title: '请求被拒绝', message: '来源校验失败。' }))
    }
    if (!allowRegistration(request.ip ?? null)) {
      return reply.code(429).type('text/html').send(messagePage({ title: '操作过于频繁', message: '请稍后再试。' }))
    }
    const body = /** @type {Record<string, unknown>} */ (request.body ?? {})
    const code = typeof body.code === 'string' ? body.code : ''
    const password = typeof body.password === 'string' ? body.password : ''
    const confirm = typeof body.confirm === 'string' ? body.confirm : ''
    if (!await inspectInvite(code, 'reset')) {
      return reply
        .code(400)
        .type('text/html')
        .send(messagePage({ title: '重置链接无效', message: '重置链接不存在、已使用或已过期，请联系管理员。' }))
    }
    const problem = passwordProblem(password) ?? (password !== confirm ? '两次输入的密码不一致' : null)
    if (problem) return reply.code(400).type('text/html').send(resetPage({ code, error: problem }))

    let userId
    try {
      userId = await store.resetPasswordWithInvite({ codeHash: sha256Hex(code), passwordHash: await hasher.hash(password) })
    } catch (err) {
      if (err?.code === 'INVALID_INVITE') {
        return reply
          .code(400)
          .type('text/html')
          .send(messagePage({ title: '重置链接无效', message: '重置链接刚刚被使用或已过期，请联系管理员。' }))
      }
      throw err
    }
    audit({ action: 'password.reset', target: userId, ip: request.ip ?? null })
    const instance = await store.getInstanceByUser(userId)
    return reply.type('text/html').send(messagePage({
      title: '密码已重置',
      message: '所有旧会话已失效，请重新登录。',
      link: instance ? { href: `http://127.0.0.1:${instance.host_port}/`, text: '前往我的实例' } : undefined,
    }))
  })

  app.route({
    method: ['GET', 'POST'],
    url: '/logout',
    async handler(request, reply) {
      const current = await sessionFromRequest(request)
      if (current) {
        await store.revokeSession(sha256Hex(current.token))
        audit({ action: 'logout', target: current.row.user_id, ip: request.ip ?? null })
      }
      reply.header(
        'set-cookie',
        serializeCookie(config.cookieName, '', { maxAge: 0, secure: config.secureCookie }),
      )
      return reply
        .type('text/html')
        .send(messagePage({ title: '已退出', message: '登录态已清除，可以关闭此页面。' }))
    },
  })

  app.post('/introspect', async (request, reply) => {
    const session = /** @type {{session?: unknown}} */ (request.body ?? {}).session
    if (typeof session !== 'string' || session === '') {
      return reply.code(400).send({ error: 'session required' })
    }
    const idHash = sha256Hex(session)
    const row = await store.findSession(idHash)
    if (!row) return reply.code(401).send({ error: 'invalid session' })
    await store.touchSession(idHash)
    const instance = await store.getInstanceByUser(row.user_id)
    return reply.send({
      user_id: row.user_id,
      username: row.username,
      instance: instance ? { host_port: instance.host_port, status: instance.status } : null,
    })
  })

  app.get('/healthz', async (_request, reply) => {
    try {
      await store.ping()
      return reply.send({ ok: true, service: 'auth' })
    } catch {
      return reply.code(503).send({ ok: false, service: 'auth' })
    }
  })

  app.setNotFoundHandler((_request, reply) => {
    reply.code(404).type('text/html').send(messagePage({ title: '页面不存在', message: '检查地址是否正确。' }))
  })

  app.setErrorHandler((error, request, reply) => {
    logger.error({ event: 'request-error', url: request.url, message: String(error?.message ?? error) })
    if (!reply.sent) reply.code(500).type('text/html').send(messagePage({ title: '服务异常', message: '请稍后重试。' }))
  })

  return app
}
