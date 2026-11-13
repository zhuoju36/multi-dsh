# 接口契约（一期 + 路径 router）

三个服务之间的接口以本文为准；实现变更必须同步更新。

## 1. auth（平台账号）

监听容器内 `0.0.0.0:18080`，宿主 `127.0.0.1:18080`。浏览器经 router（`127.0.0.1:18000`）访问；gateway 通过容器网络访问。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/login?next=<url>` | 登录页。`next` 可省略（统一登录）；带 `next` 时接受 router 路径 `http://127.0.0.1:18000/u/<id>/`（也兼容旧端口），实例不存在则 400。 |
| POST | `/login` | `application/x-www-form-urlencoded`：`username`、`password`、可选 `next`。无 `next` 时成功 303 到自己的 `/u/<id>/`；有 `next` 时跳 `next`（不属于该用户则跳自己的）；失败 401；来源校验失败 403；限流 429。 |
| GET/POST | `/logout` | 吊销当前会话并清 cookie，返回 200 HTML。 |
| GET | `/register?code=<invite>` | 邀请码注册页；码无效/过期/已用返回 400。 |
| POST | `/register` | 表单：`code`、`username`、`password`、`confirm`。校验邀请码并原子消费 → 创建账号 → 调 Hub 建实例 → 自动登录并 303 到 `http://127.0.0.1:18000/u/<id>/`。用户名冲突 409，Hub 失败 502。 |
| GET | `/reset?code=<reset>` | 重置密码页。 |
| POST | `/reset` | 表单：`code`、`password`、`confirm`；重置后吊销该用户全部旧会话。 |
| POST | `/introspect` | 内网接口，JSON `{session}`。有效返回 `{user_id, username, instance: {host_port, status} \| null}`；无效 401；格式错误 400。 |
| GET | `/healthz` | `{ok:true, service:"auth"}`；数据库不可达返回 503。 |

约定：

- 密码 Argon2id；会话 ID 为 32 字节随机值，数据库只存 SHA-256 哈希。
- 登录失败按 `username + ip` 计数，5 分钟窗口内 5 次后 429。
- 所有登录/注销/限流事件写 `audit_log`。

## 1.5 router（公开入口）

监听宿主机 `127.0.0.1:18000`（Compose `network_mode: host`），浏览器唯一入口。

| 路径 | 行为 |
|---|---|
| `/u/<user-id>/...` | 查 `instances.host_port`（5s 缓存）→ 剥掉 `/u/<id>` → 转发租户 gateway；`Host` 保持公开值；`Set-Cookie` 的 `Path` 重写为 `/u/<id>/`；`Location: /...` 同步加前缀；WebSocket 升级透传。 |
| `/u/<user-id>` | 301 到 `/u/<user-id>/`。 |
| `/` | 统一登录入口：未登录显示登录表单；已登录 303 到自己的 `/u/<id>/`。 |
| 其他路径 | 原样转发 auth（`127.0.0.1:18080`）。 |
| `Host: localhost` | 301 到 `127.0.0.1:18000` 同路径（避免 host-only cookie 丢失）。 |
| `/healthz` | router 自身健康检查。 |

实例不存在 404；状态不是 `ready` 返回 503 + `Retry-After`。平台会话与租户的绑定仍由租户 gateway 校验（跨用户 403），router 不做认证。

## 2. gateway（每租户入口）

监听容器内 `0.0.0.0:8080`，宿主只映射 `127.0.0.1:<HOST_PORT>:8080`。浏览器不应直接使用该端口；经 router `/u/<id>/` 访问。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `LISTEN_PORT` | `8080` | 监听端口 |
| `DSH_HOST` / `DSH_PORT` | `127.0.0.1` / `3080` | 同容器内 DSH |
| `TENANT_ID` | `dev` | 本实例租户，必须与平台会话的 `user_id` 相等 |
| `USER_HOST` | `127.0.0.1:<LISTEN_PORT>` | 浏览器侧 authority，生成登录回跳 |
| `TOKEN_FILE` | `/run/dsh/launch-token` | entrypoint 捕获的 DSH launch token |
| `AUTH_INTERNAL_URL` | 必填 | gateway 调 `/introspect` 的地址，如 `http://auth:18080` |
| `AUTH_PUBLIC_URL` | 必填 | 浏览器登录地址（router），如 `http://127.0.0.1:18000` |
| `AUTH_COOKIE` | `mdsh_session` | 平台会话 cookie 名 |
| `AUTH_CACHE_MS` | `30000` | introspect 缓存 |
| `DSH_COOKIE_TTL_MS` | `21600000` | DSH cookie 缓存 |
| `MAX_CLIENT_BODY_BYTES` | `335544320` | 按 `Content-Length` 提前拒绝的超大上传（与 DSH 300 MiB 载体对齐） |
| `GATEWAY_DEV_MODE` | 未设置 | `1` 时跳过平台认证，仅本地冒烟使用；生产禁止设置 |

行为：

1. `GET /healthz` 探测 DSH 端口。
2. 平台 cookie → `POST {AUTH_INTERNAL_URL}/introspect`；401/无 cookie → 303 到 `{AUTH_PUBLIC_URL}/login?next=<本实例>`；`user_id` 不等于 `TENANT_ID` → 403；auth 不可达 → 503。
3. 首次请求：读 `TOKEN_FILE`，用浏览器 `Host` 本地 `GET /?token=…` 换 DSH cookie，303 回浏览器；后续请求复用缓存。
4. 反代保留 `Host`、透传 WebSocket 与流式响应；转发前剥离平台 cookie；客户端断开时关闭上游。
5. 上游 DSH 返回 401 时丢弃缓存 cookie，让浏览器重试一次。

## 3. llm-gateway（模型网关）

监听 `0.0.0.0:18090`，**不发布到宿主**，只加入 `multi-dsh-edge` 网络供租户访问。

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `18090` | 监听端口 |
| `DATABASE_URL` | 必填 | PostgreSQL |
| `UPSTREAM_BASE_URL` | `https://api.deepseek.com/anthropic` | 必须带 `/anthropic` 前缀 |
| `PLATFORM_API_KEY` | 必填 | 平台真 key，永不进入租户容器 |
| `MONTHLY_QUOTA_TOKENS` | `0` | 每租户每月 token 上限，0 = 不限 |
| `UPSTREAM_TIMEOUT_MS` | `600000` | 上游空闲超时 |

路由表（其他路径一律 404）：

| 请求 | 上游 | 鉴权头 |
|---|---|---|
| `POST /v1/messages` | `${UPSTREAM_BASE_URL}/v1/messages` | `x-api-key` |
| `POST/GET/DELETE /v1/files*` | `${UPSTREAM_BASE_URL}/v1/files*` | `x-api-key` |
| `GET /models` | `${UPSTREAM_ORIGIN}/models` | `x-api-key` |
| `POST /v1/tools/search`、`/v1/tools/fetch` | `${UPSTREAM_ORIGIN}/v1/tools/*` | `Authorization: Bearer` |

- 虚拟 key 为 `sk-mdsh-…`，数据库只存 SHA-256；无效/缺失 → 401。
- 转发前把虚拟 key 换成平台真 key，删除客户端 `Host`、`accept-encoding`（改为 `identity`）与另一类鉴权头。
- SSE 边透传边解析 `message_start` / `message_delta` 的用量；客户端断开时销毁上游并记录 `status=499`。
- 每条请求写 `llm_usage`：`user_id, kind, model, input/output/cache_read/cache_write, status, duration_ms`。
- 配额按 UTC 自然月、`input+output` 计算；超限返回 429。
- 错误体：`{ "type": "error", "error": { "type": "...", "message": "..." } }`。
- `GET /healthz` → `{ok:true, service:"llm-gateway"}`。

## 5. Hub（控制面）

宿主 systemd 服务，监听 Unix socket `/srv/multi-dsh/run/hub.sock`（容器内挂到 `/run/multi-dsh/hub.sock`）。除 `/healthz` 外都要求 `Authorization: Bearer $HUB_TOKEN`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/internal/instances` | JSON `{user_id}`；幂等创建/启动实例，返回 `{host_port, status}` |
| POST | `/internal/instances/:userId/ensure` | 确保运行（登录时由 auth 调用） |
| POST | `/internal/instances/:userId/stop` | JSON `{reason?}`；停止容器并记 `stop_reason` |
| GET | `/internal/instances/:userId` | DB 行 + `docker inspect` 状态 |
| GET | `/healthz` | `{ok:true, service:"hub"}` |

邀请码/重置码不暴露 HTTP 管理接口，由宿主机 CLI 生成：

```sh
node services/auth/src/cli.mjs invite create --hours 72 [--uses 1]
node services/auth/src/cli.mjs reset create --username alice [--hours 24]
```

## 4. DSH 侧配置

租户容器只设置：

```
DEEPSEEK_BASE_URL=http://llm-gateway:18090
DEEPSEEK_API_KEY=<租户虚拟 key>
```

DSH 会请求 `${DEEPSEEK_BASE_URL}/v1/messages`；内置 Search/Fetch 使用 base URL 的 origin + `/v1/tools/*`；模型列表使用 `${origin}/models`——均落在上表内。
