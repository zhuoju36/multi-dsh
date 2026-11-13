# services/gateway

每用户容器的入口进程（与 dsh 同容器，由 entrypoint 先起）。零第三方依赖，Node ≥ 22.13。

## 职责

1. 校验平台会话：调 `auth /introspect`（30s 缓存），并确认 `user_id == 本实例租户`，否则 403；auth 不可达 503；无会话 303 到登录页。
2. 登录页地址用 `AUTH_PUBLIC_URL`（浏览器可达），内网调用用 `AUTH_INTERNAL_URL`——两者必须分开配置，否则浏览器会被跳到 `auth:18080` 这类不可解析的主机名。
3. 首次：读 `TOKEN_FILE`，以浏览器侧 `Host` 本地 `GET /?token=…` 换 DSH cookie，303 回浏览器；之后复用缓存。
4. 反代到 `127.0.0.1:DSH_PORT`：保留 `Host`、透传 WebSocket 与流式响应；转发前**剥离平台 cookie**，避免 `mdsh_session` 泄漏给 DSH。
5. `GET /healthz`：TCP 探测 DSH 端口；`Content-Length` 超限直接 413（与 DSH 300 MiB 载体对齐）；`requestTimeout=0` 支持大附件上传。
6. 结构化 JSON 日志，不含 token/cookie；上游 401 时丢弃缓存并让浏览器重试一次。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `LISTEN_PORT` | `8080` | gateway 监听；容器内绑 `0.0.0.0`，宿主只映射 loopback |
| `DSH_HOST` / `DSH_PORT` | `127.0.0.1` / `3080` | 同容器 DSH |
| `TENANT_ID` | `dev` | 本实例租户，用于会话归属校验 |
| `USER_HOST` | `127.0.0.1:<LISTEN_PORT>` | 浏览器侧 authority |
| `TOKEN_FILE` | `/run/dsh/launch-token` | entrypoint 写入的 launch token |
| `AUTH_INTERNAL_URL` | 必填 | 如 `http://auth:18080` |
| `AUTH_PUBLIC_URL` | 必填 | router origin，如 `http://127.0.0.1:18000` |
| `AUTH_COOKIE` | `mdsh_session` | 平台会话 cookie 名 |
| `AUTH_CACHE_MS` | `30000` | introspect 缓存 |
| `DSH_COOKIE_TTL_MS` | `21600000` | DSH cookie 缓存 |
| `MAX_CLIENT_BODY_BYTES` | `335544320` | 上传体积上限（按 Content-Length 提前拒绝） |
| `GATEWAY_DEV_MODE` | 未设置 | `1` 跳过平台认证，仅本地冒烟；生产禁止 |

## 本地验证

```sh
DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/smoke-gateway.sh
```

单测：`pnpm --filter @multi-dsh/gateway test`（覆盖登录跳转、租户不匹配、auth 不可达、413、WS 升级、dev 模式）。

## 实测结论（DSH 0.2.2-rc.2）

- 首请求：`303 + Set-Cookie: dsh-auth-<hash>=v1.{authority:"127.0.0.1:<port>"}`。
- 带 cookie 的后续请求经代理返回 200；WebSocket `/api/remote.mux` 升级返回 101。
- **authority 跟随 `Host`**：交换与代理必须用同一个 `Host`，否则稳定 401。
- **不能用 `fetch()` 做交换**：Node 的 fetch 忽略自定义 `Host`，必须用 `http.request`。

## 已知限制（一期）

- DSH cookie 缓存是进程内 Map：gateway 重启后重新交换（浏览器无感）。
- 未实现请求级令牌桶/限速/审计落库。
- 未校验 `Origin`（同源场景由 DSH 自身栅栏兜底）。
