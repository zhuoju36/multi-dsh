# services/router

按路径前缀 `/u/<id>/` 路由到实例；当前已作为公开入口运行在 `127.0.0.1:18000`。

职责：

- `/u/<opaque-id>/` → registry → 实例 gateway；剥前缀、重写 DSH cookie `Path`、保留公开 `Host`。
- 进程内缓存（TTL 5s + 变更通知）；反代保留 `Host`、透传 WebSocket 与流式响应。
- 实例未就绪返回 503 + `Retry-After`；未知租户 404。
- 其余路径（含 `/` 统一登录）原样转发到 auth（`127.0.0.1:18080`）。
- 路由表直接查 PostgreSQL（5s 缓存），不依赖静态配置或 reload。
- `/healthz`、`/metrics`（按租户聚合）。

子域 `user-<id>.example.com` 作为 fallback（通配 DNS + 通配证书）。

不做：DSH 协议感知、TLS 终止（在 LB）。

三期按 id 哈希分片，每片多副本。
