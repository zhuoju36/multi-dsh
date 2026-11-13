# services/llm-gateway

平台模型 key 的唯一持有者，同时是**按租户计量的唯一可信点**。

一期职责：

- 校验租户虚拟 key（`llm-<id>-<随机>`，存 PG，可吊销/轮换）。
- 注入平台真 key，转发到 `UPSTREAM_BASE_URL`（默认 `https://api.deepseek.com`）。
- **流式透传**（SSE）：不缓冲、不改写事件，保持首 token 延迟；如实关闭中断连接。
- 记账：每次请求写 `tenant_id / model / input / output / cache_read / cache_write / ts / status`。
- 配额：按租户月度 token 上限，超限 429（可配置告警阈值）。
- 审计：请求元数据（不含 prompt/response 正文）。

为什么在这里：

- 平台统一 key 意味着额度共享，必须在离模型最近处拆分归属。
- DSH 的 `token-meter` 是重放估算（非账单口径），`session-telemetry-otel` 默认只导出显式反馈，都不能替代网关记账。
- 网关还能拦截绕行、做异常调用审计与限速。

配置见 `docs/deployment.md`：DSH 侧只设 `DEEPSEEK_BASE_URL=http://llm-gateway:18090` 与租户虚拟 `DEEPSEEK_API_KEY`。
