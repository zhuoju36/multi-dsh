# multi-dsh

把 DeepSeek Harness（DSH）容器化，做成**多租户托管服务**：一个用户 = 一个容器，DSH 自身保持单租户。

> 状态：**一期 + Hub 控制面 + 路径前缀 router 已在本机跑通**。平台（PostgreSQL / auth / llm-gateway / MinIO / Hub / router）+ 6 个租户容器健康；公开入口 `http://127.0.0.1:18000/`（统一登录，按身份跳 `/u/<id>/`），邀请码注册 → Hub 建实例 → 自动登录 → DSH 首页验证通过；停实例后登录自动拉起；真实模型调用已验证。
> 一期范围：单机 Docker Compose、自建密码登录、平台统一模型 key + 按租户计量、S3 兼容备份；域名与 TLS 推迟到正式上线。

## 一期形态（当前唯一实现范围）

```
浏览器  http://127.0.0.1:18000/  → 统一登录 → /u/<user-id>/
   │
   ▼
router 127.0.0.1:18000 → 内部 127.0.0.1:18001 → 容器 8080（仅本机）
   │
   ▼
dsh-<id> 容器（每用户一个）
   ├─ gateway :8080              ① 平台会话校验 ② DSH launch-token 交换 ③ 反代
   ├─ dsh web :3080 (loopback)   DSH_HOME=/data/dsh-home
   ├─ /data                      named volume（该用户独占）
   └─ /opt/multi-dsh             只读（运行时、内容包、技能源、部署 patch）
   │
   ├─▶ router      :18000  /u/<id>/ 路径入口；其余路径转 auth:18080
   ├─▶ llm-gateway :18090  平台真 key 只在这里；DSH 用租户虚拟 key，按 token 记账
   └─▶ backup      restic → S3 兼容对象存储（宿主机定时任务）
```

- **没有域名、没有 TLS**：一期只在本机（`127.0.0.1`）或受控内网使用。DSH 的 launch token、会话 cookie 都是明文 HTTP，**不得暴露到公网**；上线前必须补 TLS 与路径前缀入口（见 ADR-0009）。
- 统一入口：`http://127.0.0.1:18000/` 登录后按身份 303 到 `/u/<user-id>/`；router 剥前缀后转发到内部 `18001`–`18010`；DSH cookie 名相同，由 router 把 `Path` 重写到 `/u/<id>/` 隔离。
- 平台 cookie 是 `127.0.0.1` 上的 host-only cookie（cookie 不区分端口），因此会带到所有端口；gateway 必须校验"cookie 的 user_id == 本实例租户 id"，否则拒绝。

## 目标架构（2/3 期演进，当前不实现）

```
浏览器  https://user-<opaque-id>.example.com
   ▼
云 LB / Ingress（TLS 终止，通配证书）
   ▼
router（无状态，按 Host 查 registry）──▶ 每用户 Pod（gateway + dsh + PVC）
   ▲
   └─ auth / registry(PG) / provisioner
```

（`example.com` 为占位域名；二期再确定真实域名与证书签发方式。）

演进要点：路由从"端口"换成"路径前缀 + router"（子域为备选）；TLS 在 LB 终止；编排从 Compose 换到 K8s；备份不变（仍是 restic → S3）。共享的始终只有只读镜像与内容包，可写状态全在该用户独占的卷里。

## 快速开始

```sh
pnpm install          # 安装 workspace 依赖（Node 24 LTS）
pnpm test             # 全部服务的单元测试（无需 PostgreSQL / Docker）
# 本机无 Docker 时，用真实 DSH checkout 冒烟 gateway：
DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/smoke-gateway.sh
```

部署到 Docker 主机、开通租户与备份恢复见 [docs/deployment.md](docs/deployment.md)。

## 本机（Ubuntu）试点部署

```sh
sudo bash deploy/host-setup.sh        # 安装 Docker/Compose/buildx/restic，建 /srv/multi-dsh，写 secrets
# 填 /srv/multi-dsh/secrets/platform.env 的 PLATFORM_API_KEY
sudo bash deploy/bootstrap-local.sh   # 拉镜像、起平台+MinIO、迁移、构建用户镜像、开 5 个租户
```

邀请码注册（管理员生成一次性码，用户自设密码）：

```sh
node services/auth/src/cli.mjs invite create --hours 72
# 把打印出的 http://127.0.0.1:18000/register?code=... 发给用户（已有账号直接访问 http://127.0.0.1:18000/ 登录）
```

租户 URL、密码与虚拟 key 写在 `/srv/multi-dsh/secrets/pilot-tenants.txt`（0600）。Docker Hub 不可达，脚本从 `docker.m.daocloud.io` / `docker.1panel.live` 显式拉取基础镜像。

平台模型 key 在 `/srv/multi-dsh/secrets/platform.env` 的 `PLATFORM_API_KEY`；改完后重启 llm-gateway：

```sh
docker compose -f deploy/compose/compose.platform.yml --env-file /srv/multi-dsh/secrets/platform.env up -d llm-gateway
```

## 设计原则

1. **DSH 不感知多租户**：上游升级不依赖 fork，多租户逻辑全在容器外。
2. **共享只读，独占可写**：镜像与内容包共享，DSH_HOME 与工作区一人一份。
3. **身份在入口**：浏览器先过平台账号（cookie），再过 DSH 自己的 launch token。
4. **默认拒绝**：DSH 只绑 loopback；容器不发布额外端口；egress 只到网关与模型 API。
5. **按阶段演进**：一期只做能运维的最小闭环，不为 1000 用户提前付复杂度。

## 目录结构

```
docs/                   架构、租户、部署、运维、接口契约、容量
db/                     单一 schema 权威：migrations/ + migrate.mjs
packages/shared/        零依赖工具（logger/config/cookies/ids）
packages/db/            PostgreSQL 连接池与仓储查询
deploy/docker/          用户镜像、平台镜像、entrypoint、部署 patch
deploy/compose/         平台编排 + 每租户编排 + 备份/恢复脚本
deploy/k8s/             （二期）实例与共享组件清单模板
services/auth/          账号、登录、PG 会话、gateway introspect
services/gateway/       每实例入口：会话校验 + token 交换 + 反代（零第三方依赖）
services/llm-gateway/   平台 key 唯一持有者：Messages 协议路由 + SSE 计量 + 配额
services/provisioner/   宿主机 CLI：开通/删除/轮换 key/用量报表
services/router/        （二期）按 Host 路由
scripts/smoke-gateway.sh 无 Docker 的端到端冒烟
```

## 三期容量路线

| 阶段 | 用户数 | 形态 | 关键工作 |
|---|---|---|---|
| 1 期 | ≤ 10 | 单机 Compose，`127.0.0.1:端口` | 一人一容器、命名卷、密码登录、LLM 计量、restic→S3；实测 16C/32G/500GB |
| 2 期 | ≤ 100 | K8s 多节点 | 路径前缀 + TLS、router、自动开通、滚动升级、每租户指标 |
| 3 期 | ≤ 1000 | 分片 router + 弹性 | 空闲挂起/唤醒、内容包独立分发、成本核算 |

## 已定决策（一期）

| 决策 | 结论 |
|---|---|
| 编排 | 只用 Docker Compose（单机），K8s 目录先留空 |
| 账号 | 自建密码登录（Argon2id），服务端会话表 + 签名 cookie |
| 模型凭证 | 平台统一 key 只存在 llm-gateway；DSH 用租户虚拟 key，网关按 token 计量与限额 |
| 对象存储 | S3 兼容（MinIO / 云 S3），restic 加密备份 |
| 域名与证书 | 一期不做，上线前再定 |
| 编排形态 | 平台一套 Compose + 每租户独立 Compose project（同一 `multi-dsh-edge` 网络） |
| 模型协议 | 按 Anthropic Messages 协议显式路由（messages/files/models/tools），非 OpenAI chat/completions |
| 用户文件 | 租户宿主目录 bind mount + XFS project quota；S3（一期同机 MinIO）只做 restic 备份 |
| 计量 | 平台真 key 只在 llm-gateway；每租户虚拟 key 只做归属，用量写入 PG |

## 仍待确认

- 数据盘能否格式化为 XFS（决定硬配额，否则先软配额 + 告警）？
- S3 具体供应商 / 是否先用 MinIO 自建？
- 一期是否允许内网访问（非本机）？若要，TLS 与访问控制必须提前（不只是"上线再说"）。
- 单用户资源上限（一期默认 2C2G / 20GiB，大附件用户 4GiB）是否合适？

## 文档

- [docs/architecture.md](docs/architecture.md) — 组件、请求链路、DSH 约束、关键决策
- [docs/api.md](docs/api.md) — auth / gateway / llm-gateway 的接口契约
- [docs/tenancy.md](docs/tenancy.md) — 租户身份、数据布局、生命周期、配额、演进
- [docs/capacity.md](docs/capacity.md) — 一期硬件实测与选型（10 用户）、二期换算
- [docs/deployment.md](docs/deployment.md) — 镜像、入口脚本、Compose 编排、网络与参数
- [docs/operations.md](docs/operations.md) — 备份恢复、升级回滚、计量、可观测性、Runbook
