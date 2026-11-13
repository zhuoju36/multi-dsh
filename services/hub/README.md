# services/hub

控制面（JupyterHub 的 Hub 角色）：实例生命周期、spawner、reconcile、空闲回收。**不在请求数据面**，前端流量仍走每租户 gateway。

## 接口

监听 Unix socket `/srv/multi-dsh/run/hub.sock`，auth 容器挂载到 `/run/multi-dsh/hub.sock`。除 `/healthz` 外都需要 `Authorization: Bearer $HUB_TOKEN`。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/internal/instances` | `{user_id}`；幂等创建/启动，返回 `{host_port, status}` |
| POST | `/internal/instances/:userId/ensure` | 登录时确保实例运行 |
| POST | `/internal/instances/:userId/stop` | `{reason?}`；停止并记录原因 |
| GET | `/internal/instances/:userId` | DB 状态 + 容器状态 |
| GET | `/healthz` | 健康检查 |

管理侧用 `curl --unix-socket /srv/multi-dsh/run/hub.sock -H "Authorization: Bearer $HUB_TOKEN" ...`。

## 实现

- `src/spawner.mjs`：`DockerComposeSpawner`
  - `ensureDataDir`：用 `node:24-slim` 容器以 root 建 `/srv/multi-dsh/volumes/<id>/data` 并 chown 10001（Hub 本身不需要 root）。
  - `start`：`docker compose -p dsh-<id> --env-file … up -d --wait`。
  - `stop`：`docker stop <container>`。
  - `activity`：查询租户 gateway 的 `/internal/activity`（HTTP/WS 活动）。
- `src/service.mjs`：Fastify + 状态机；创建实例时分配端口、签虚拟 key、渲染 env、启动容器、置 `ready`；失败置 `failed`。
- `src/server.mjs`：启动时 reconcile，之后按 `CULL_INTERVAL_MS` 做空闲回收（`IDLE_TIMEOUT_MS` 默认 0 = 关闭）。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `PLATFORM_ENV_FILE` | `/srv/multi-dsh/secrets/platform.env` | 读取 POSTGRES_* 与 HUB_TOKEN |
| `HUB_SOCKET` | `/srv/multi-dsh/run/hub.sock` | Unix socket |
| `REPO_ROOT` / `DATA_ROOT` | 仓库根 / `/srv/multi-dsh/volumes` | 宿主路径 |
| `DSH_IMAGE` / `DSH_VERSION` | `multi-dsh/dsh:0.2.2-rc.2` | 新实例使用的镜像 |
| `TENANT_CPUS` / `TENANT_MEMORY` | `2` / `1536m` | 租户资源 |
| `IDLE_TIMEOUT_MS` | `0` | 空闲回收阈值，0 = 关闭 |
| `CULL_INTERVAL_MS` | `60000` | 回收检查间隔 |
| `RECONCILE_ON_START` | `1` | 启动时对账 |

## systemd

`deploy/systemd/multi-dsh-hub.service`，以 `hzj` 运行，`Restart=always`；需要 docker 组/socket 访问权限与 `/srv/multi-dsh` 写权限。

## 测试

`pnpm --filter @multi-dsh/hub test`：创建实例（端口/env/启动调用）、stop、空闲回收（有/无 WS）、reconcile。
