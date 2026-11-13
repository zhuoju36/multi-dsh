# services/gateway

每用户容器的入口进程（一期与 dsh 同容器，由 entrypoint 先起；二期拆 sidecar）。原型实现见 `server.mjs`（零依赖，Node ≥ 22）。

## 职责

1. 校验平台会话：调 `auth /introspect`（30s 缓存），并确认 `user_id == 本实例租户`，否则 403。
2. 无会话 → 303 到 `AUTH_URL/login?next=http://USER_HOST/`。
3. 首次：读 `TOKEN_FILE`，以**浏览器侧的 `Host`** 本地 `GET /?token=…`，把 303 + `Set-Cookie` 回给浏览器（`Location` 改为 `./`），之后复用缓存 cookie。
4. 反代到 `127.0.0.1:DSH_PORT`：保留 `Host`，透传 `Upgrade`/流式响应；上游 401 时丢弃缓存、重新交换一次。
5. `GET /healthz`：TCP 探测 DSH 端口。
6. 记录 `token-exchanged` / `proxy-error` 等结构化日志（不含 cookie 与 token）。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `LISTEN_PORT` | `8080` | gateway 监听；容器内绑 `0.0.0.0`，宿主只映射 loopback |
| `DSH_HOST` / `DSH_PORT` | `127.0.0.1` / `3080` | DSH 监听地址（entrypoint 会把 `DSH_WEB_PORT` 传给 `DSH_PORT`） |
| `TENANT_ID` | `dev` | 本实例租户；用于会话归属校验 |
| `USER_HOST` | `127.0.0.1:<LISTEN_PORT>` | 浏览器侧 authority，用于登录回跳 |
| `AUTH_URL` | 空 | 空 = dev 模式（跳过平台认证，仅本地调试） |
| `AUTH_COOKIE` | `mdsh_session` | 平台会话 cookie 名 |
| `TOKEN_FILE` | `/run/dsh/launch-token` | entrypoint 写入的 DSH launch token |

## 实测结论（本机参考 DSH 0.2.1-rc.3）

- 首请求：`303 + Set-Cookie: dsh-auth-<hash>=v1.{authority:"127.0.0.1:<port>"}`。
- 带 cookie 的后续请求经代理返回 200；WebSocket `/api/remote.mux` 升级返回 101。
- **authority 跟随 `Host`**：交换与代理必须用同一个 `Host`，否则稳定 401。
- **不能用 `fetch()` 做交换**：Node 的 fetch 忽略自定义 `Host`（forbidden header），会把 cookie 绑到 DSH 端口；必须用 `http.request`。

## 已知限制（原型）

- 会话缓存是进程内 Map：gateway 重启后要重新交换（浏览器无感，DSH cookie 仍有效于 DSH 进程）。
- 未实现请求级令牌桶、限速、审计落库。
- 未校验 `Origin`（同源场景下由 DSH 自身的栅栏兜底）。
