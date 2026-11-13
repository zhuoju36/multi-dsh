# services/llm-gateway

平台模型 key 的唯一持有者，同时是**按租户计量的唯一可信点**。

## 协议与路由

DSH 使用 **Anthropic Messages 协议**（默认 base `https://api.deepseek.com/anthropic`），不是 OpenAI `chat/completions`。网关按显式路由表转发（其余 404）：

| DSH 请求 | 上游 |
|---|---|
| `POST /v1/messages` | `${UPSTREAM_BASE_URL}/v1/messages` |
| `/v1/files*` | `${UPSTREAM_BASE_URL}/v1/files*` |
| `GET /models` | `${UPSTREAM_ORIGIN}/models` |
| `POST /v1/tools/search`、`/v1/tools/fetch` | `${UPSTREAM_ORIGIN}/v1/tools/*` |

虚拟 key 从 `x-api-key`（Messages/Files/Models）或 `Authorization: Bearer`（Search/Fetch）读取，转发时替换成平台真 key。

## 职责

- 校验租户虚拟 key（`sk-mdsh-…`，PG 只存 SHA-256，可吊销/轮换）。
- 注入平台真 key，转发到 `UPSTREAM_BASE_URL`（必须带 `/anthropic` 前缀）。
- **SSE 边透传边解析**：从 `message_start` 取 `input_tokens / cache_read / cache_write`，`message_delta` 取 `output_tokens`；去掉客户端 `accept-encoding`（改 `identity`）保证可解析；客户端断开立即销毁上游。
- 记账：每条请求写 `llm_usage`（租户、kind、模型、四类 token、状态、耗时）。
- 配额：`MONTHLY_QUOTA_TOKENS`（UTC 自然月、input+output），超限 429；0 = 不限。
- 日志不含 prompt/response 正文与 key。

## 配置

见 [docs/api.md](../../docs/api.md) §3 与 [deploy/compose/.env.example](../../deploy/compose/.env.example)。

## 测试

`pnpm --filter @multi-dsh/llm-gateway test`：路由表、SSE 解析（含跨 chunk）、key 提取、四条路由的转发头、配额拒绝；使用假上游与内存 store。
