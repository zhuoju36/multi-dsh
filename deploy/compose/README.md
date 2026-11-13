# deploy/compose

一期唯一编排（目标 ≤ 10 用户）。`docker compose` 管平台组件与每用户容器。

计划内容：

- `compose.yml` — `postgres`、`auth`（:18080）、`llm-gateway`（:18090），以及每用户一个 `dsh-<id>` 服务。
- `tenants/<id>.env` — 每用户参数：`USER_ID`、`USER_HOST=127.0.0.1:<port>`、虚拟 key、资源上限。
- `scripts/provision.sh` — 开通：分配端口 → 签发虚拟 key → 渲染 env → `up -d` → 等 healthcheck。
- `scripts/backup.sh` — `docker compose stop dsh-<id>` → restic backup → `start`；或按卷直接快照。
- `scripts/restore.sh` — 恢复卷到临时容器验证。

硬约束：

- 用户端口只映射到 `127.0.0.1`，不发布 DSH 的 3080。
- 每用户一个 named volume，不共享。
- 平台 key 只出现在 `llm-gateway` 的环境里。
- 一期无 TLS：不监听 `0.0.0.0`，不接公网。

详见 `docs/deployment.md` 第 4 节的编排示意。
