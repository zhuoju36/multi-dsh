# services/router

（二期）按 `Host` 路由到实例。一期**不需要**：端口直达。

二期范围：

- 子域 `user-<id>.example.com` → registry → 实例 gateway。
- 进程内缓存（TTL 5s + 变更通知）；反代保留 `Host`、透传 WebSocket 与流式响应。
- 实例未就绪返回 503 + `Retry-After`。
- `/healthz`、`/metrics`（按租户聚合）。

不做：Cookie 解析、DSH 协议感知、TLS 终止（在 LB）。

三期按 id 哈希分片，每片多副本。
