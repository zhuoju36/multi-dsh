# services/auth

自建账号体系与登录态签发。DSH 不感知账号——这里是"用户浏览器"与"该用户实例"之间唯一的身份来源。实现：Fastify 5 + PostgreSQL 会话 + Argon2id。

## 接口

完整契约见 [docs/api.md](../../docs/api.md) §1。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/login?next=…` | 登录页；`next` 必须是 registry 中已存在实例的 `http://127.0.0.1:<port>/` |
| POST | `/login` | 表单登录；成功 303 回实例，失败 401，来源校验 403，限流 429 |
| GET/POST | `/logout` | 吊销会话、清 cookie |
| POST | `/introspect` | gateway 内网调用，返回 `{user_id, username, instance}` |
| GET/POST | `/register` | 邀请码注册（一次性、72h、不绑定用户名）；成功后调 Hub 建实例并自动登录 |
| GET/POST | `/reset` | 管理员签发的 reset 码重置密码，吊销全部旧会话 |
| GET | `/healthz` | 数据库可达则 200 |

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `18080` | 监听端口 |
| `DATABASE_URL` | 必填 | PostgreSQL |
| `AUTH_PUBLIC_URL` | `http://127.0.0.1:18000` | 浏览器 origin（router），用于 POST Origin 校验 |
| `AUTH_COOKIE` | `mdsh_session` | 会话 cookie 名 |
| `SESSION_TTL_HOURS` | `12` | 会话有效期 |
| `LOGIN_WINDOW_MINUTES` | `5` | 登录失败统计窗口 |
| `LOGIN_MAX_FAILURES` | `5` | 窗口内允许的失败次数 |
| `AUTH_COOKIE_SECURE` | 未设置 | 上 TLS 后设 `1` |

## 邀请码 / 重置码

管理员用宿主机 CLI 生成（只存哈希，打印一次）：

```sh
# 默认读取 /srv/multi-dsh/secrets/platform.env；也可用 PLATFORM_ENV_FILE 覆盖
node services/auth/src/cli.mjs invite create --hours 72
node services/auth/src/cli.mjs reset create --username alice
```

注册成功后 auth 通过 Unix socket 调 Hub `POST /internal/instances`；Hub 不可用时返回 502 页面（账号已创建，实例待运维重试）。

## 安全要点

- 密码 Argon2id（m=19 MiB, t=2, p=1）；未知用户也执行一次校验以对齐耗时。
- cookie 值为 32 字节随机 ID，PG 只存 SHA-256；`HttpOnly; SameSite=Lax; Path=/`。
- `next` 只接受 `127.0.0.1` 的实例根路径，防开放重定向；登录后若目标实例不属于该用户，改跳用户自己的实例。
- 登录失败按 `username + ip` 限流；登录/注销/限流写 `audit_log`。
- 一期无 TLS，cookie 不带 `Secure`，只在 loopback 使用。

## 测试

`pnpm --filter @multi-dsh/auth test`（内存 store + fake hasher，不需要 PostgreSQL）。
