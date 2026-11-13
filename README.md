# multi-dsh

把 DeepSeek Harness（DSH）容器化，做成**多租户托管服务**：一个用户 = 一个容器，DSH 自身保持单租户。

> 状态：设计阶段 + 首个原型。文档与骨架已就绪；`services/gateway` 与 `deploy/docker` 有可运行原型（token 交换、反代、WebSocket 升级已在本机用真实 DSH 验证）。
> 一期范围：单机 Docker Compose、自建密码登录、平台统一模型 key + 按租户计量、S3 兼容备份；域名与 TLS 推迟到正式上线。

## 一期形态（当前唯一实现范围）

```
浏览器  http://127.0.0.1:18001/
   │
   ▼
宿主端口映射（Compose: 127.0.0.1:18001 -> 容器 8080，仅本机）
   │
   ▼
dsh-<id> 容器（每用户一个）
   ├─ gateway :8080              ① 平台会话校验 ② DSH launch-token 交换 ③ 反代
   ├─ dsh web :3080 (loopback)   DSH_HOME=/data/dsh-home
   ├─ /data                      named volume（该用户独占）
   └─ /opt/multi-dsh             只读（运行时、内容包、技能源、部署 patch）
   │
   ├─▶ auth        :18080  自建密码登录，cookie 会话（PG）
   ├─▶ llm-gateway :18090  平台真 key 只在这里；DSH 用租户虚拟 key，按 token 记账
   └─▶ backup      restic → S3 兼容对象存储（宿主机定时任务）
```

- **没有域名、没有 TLS**：一期只在本机（`127.0.0.1`）或受控内网使用。DSH 的 launch token、会话 cookie 都是明文 HTTP，**不得暴露到公网**；上线前必须补 TLS 与子域（见三期路线）。
- 端口即租户：`18001`–`18010` 分给 10 个用户，registry 记录 `user → host_port`。不共享 origin，DSH cookie 名自带端口，互不覆盖。
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

演进要点：路由从"端口"换成"子域 + router"；TLS 在 LB 终止；编排从 Compose 换到 K8s；备份不变（仍是 restic → S3）。共享的始终只有只读镜像与内容包，可写状态全在该用户独占的卷里。

## 设计原则

1. **DSH 不感知多租户**：上游升级不依赖 fork，多租户逻辑全在容器外。
2. **共享只读，独占可写**：镜像与内容包共享，DSH_HOME 与工作区一人一份。
3. **身份在入口**：浏览器先过平台账号（cookie），再过 DSH 自己的 launch token。
4. **默认拒绝**：DSH 只绑 loopback；容器不发布额外端口；egress 只到网关与模型 API。
5. **按阶段演进**：一期只做能运维的最小闭环，不为 1000 用户提前付复杂度。

## 目录结构

```
docs/           架构、租户、部署、运维文档
deploy/docker/  镜像构建与容器入口脚本
deploy/compose/ 一期单机编排
deploy/k8s/     （二期）实例与共享组件清单模板
services/auth/         账号、登录、会话签发
services/gateway/      每实例入口：会话校验 + token 交换 + 反代
services/llm-gateway/  平台模型 key 代理与按租户计量
services/provisioner/  实例生命周期、租户注册表
services/router/       （二期）按 Host 路由
```

## 三期容量路线

| 阶段 | 用户数 | 形态 | 关键工作 |
|---|---|---|---|
| 1 期 | ≤ 10 | 单机 Compose，`127.0.0.1:端口` | 一人一容器、命名卷、密码登录、LLM 计量、restic→S3；实测 16C/32G/500GB |
| 2 期 | ≤ 100 | K8s 多节点 | 子域 + TLS、router、自动开通、滚动升级、每租户指标 |
| 3 期 | ≤ 1000 | 分片 router + 弹性 | 空闲挂起/唤醒、内容包独立分发、成本核算 |

## 已定决策（一期）

| 决策 | 结论 |
|---|---|
| 编排 | 只用 Docker Compose（单机），K8s 目录先留空 |
| 账号 | 自建密码登录（Argon2id），服务端会话表 + 签名 cookie |
| 模型凭证 | 平台统一 key 只存在 llm-gateway；DSH 用租户虚拟 key，网关按 token 计量与限额 |
| 对象存储 | S3 兼容（MinIO / 云 S3），restic 加密备份 |
| 域名与证书 | 一期不做，上线前再定 |

## 仍待确认

- S3 具体供应商 / 是否先用 MinIO 自建？
- 一期是否允许内网访问（非本机）？若要，TLS 与访问控制必须提前（不只是"上线再说"）。
- 用户虚拟 key 的签发与轮换由谁触发（provisioner 自动 / 手工）？
- 单用户资源上限（一期默认 2C4G / 10GiB 是否合适）？

## 文档

- [docs/architecture.md](docs/architecture.md) — 组件、请求链路、DSH 约束、关键决策
- [docs/tenancy.md](docs/tenancy.md) — 租户身份、数据布局、生命周期、配额、演进
- [docs/capacity.md](docs/capacity.md) — 一期硬件实测与选型（10 用户）、二期换算
- [docs/deployment.md](docs/deployment.md) — 镜像、入口脚本、Compose 编排、网络与参数
- [docs/operations.md](docs/operations.md) — 备份恢复、升级回滚、计量、可观测性、Runbook
