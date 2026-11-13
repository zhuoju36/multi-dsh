# 租户与生命周期

## 1. 租户身份

```
平台账号（用户名 / 邮箱）
   └─ users.id          opaque 主键，如 usr_7k3m9q1f（base32，16 字符）
       ├─ 容器名        dsh-<id>
       ├─ 数据目录      /srv/multi-dsh/volumes/<id>/data
       ├─ 端口          registry 分配的 18001–18010（一期）
       └─ 虚拟 key      llm-<id>-<随机后缀>（llm-gateway 签发，可吊销）
```

- 一期没有域名，用户访问 `http://127.0.0.1:<port>/`；端口即"地址"，registry 是唯一映射来源。
- `users.id` 不含邮箱等 PII；日志、卷名、容器名只用它。
- 二期引入子域后，`user-<id>.example.com` 复用同一个 ID，端口映射退役。

## 2. 数据布局

```
/srv/multi-dsh/volumes/<id>/data   →  bind mount 到 /data
  ├─ dsh-home/                     DSH_HOME
  │   ├─ profiles/web/             profile 副本（manifest + patch + node_modules）
  │   ├─ .credentials.yaml         DSH cookie 签名密钥（用户模型 key 不进这里）
  │   ├─ .env                      home 层环境（DEEPSEEK_* 由容器 env 提供，优先级更高）
  │   ├─ sessions/                 每会话 JSONL（Zstd）；goal/进度事件也在这里
  │   ├─ skills/                   用户技能
  │   ├─ attachments/v1/           附件：内容寻址、去重；图片归一化；永不自动删除
  │   └─ cache/                    可再生缓存（备份可排除）
  ├─ home/                         HOME：shell 历史、工具配置（缓存重定向到 /tmp）
  └─ projects/                     用户工作区（DSH 的 cwd）
```

- 数据目录不用 Docker named volume：overlay2 无法限容。宿主数据盘用 XFS，每租户一个 project quota（默认 20 GiB）。
- `/tmp`、`/run/dsh` 是 tmpfs；`HOME=/data/home` 保证只读根文件系统下工具仍可写。

只读层 `/opt/multi-dsh`：`packages/`（运行时与前端产物）、`content/`（内容包）、`skills-src/`（官方技能源）、`patch/`（部署级 patch、模板）。版本随镜像或内容包版本走。

## 3. 实例生命周期

```
不存在 ──开通──▶ 初始化中 ──就绪──▶ 运行中 ──停止──▶ 已停止
                     │                │              │
                     └─失败─▶ 失败     └──删除──▶ 回收中 ──▶ 已删除
```

| 状态 | 含义 | 判定 | 用户可见 |
|---|---|---|---|
| `pending` | 已登记，容器/卷创建中 | provisioner 状态机 | 开通页 |
| `ready` | 容器 Healthy，gateway 探针通过 | Compose healthcheck | 正常 |
| `running` | 有活跃请求 | gateway 记录 `last_request_at` | 正常 |
| `stopped` | 主动停止，卷保留 | `docker compose stop` | 首次访问时"启动中"页 |
| `failed` | 启动失败/崩溃循环 | 状态机 + 日志 | 错误页 + 支持入口 |
| `deleted` | 卷已删（宽限期后） | provisioner | 404 |

**开通**：`auth` 注册 → 写 `users` → 分配端口 → 签发虚拟 key → 渲染 `tenants/<id>.env` → `docker compose up -d dsh-<id>` → healthcheck 通过 → `ready`。目标 ≤ 60s（镜像已在本机）。

**删除**：标 `deleting` → 停容器、摘端口 → 卷保留 7 天 → 到期删除；S3 备份按独立保留策略保留。

## 4. 路由（一期：端口）

```
http://127.0.0.1:<port>/  →  gateway :8080  →  127.0.0.1:3080
```

- 端口表存 registry（`instances.host_port`，唯一约束）；端口段 `18001–18100`，一期用前 10 个。
- 端口被删除用户释放后，**不立即复用**（避免旧书签/旧 cookie 指到别人）；保留 30 天再回收。
- 二期换成路径前缀 router：`/u/<id>/ → instance`，端口不再对用户暴露。DSH cookie 名相同，靠 router 把 cookie `Path` 重写为 `/u/<id>/` 隔离；spike 已验证（ADR-0009）。子域作为备选。

## 5. 配额与限额（一期）

| 项 | 默认值 | 说明 |
|---|---|---|
| CPU | request 0.5 / limit 2 vCPU | 空载≈0，启动与构建是瞬时峰值 |
| 内存 | request 1 GiB / limit 2 GiB | 实测空载 375 MB（DSH 315 + gateway 62） |
| 磁盘 | 20 GiB（XFS project quota） | 超 80% 告警；XFS 未就绪时先软配额 + 告警 |
| 内存 | 2 GiB（大附件用户 4 GiB） | 200 MiB 附件上传瞬时多占 400–600 MB |
| 模型额度 | 按月 token 配额（网关执行） | 超限返回 429 并提示 |
| 登录尝试 | 5 次 / 5 分钟 / 账号 + IP | auth 限流 |
| 请求速率 | 每用户 60 rpm | 可选，gateway 令牌桶 |

配额存 registry；资源调整 = 改 `tenants/<id>.env` 后重建容器（DSH 无热改资源通道）。

## 6. 演进

### 一期（≤10）— Compose

- 单机；`docker compose` 管 auth / llm-gateway / postgres 与 10 个用户容器。
- 备份：宿主机 cron + restic → S3。
- 开通：脚本 + 手工确认（`scripts/provision.sh`）。

### 二期（≤100）— K8s + 路径前缀（入口已落地）

- 每用户 Pod + PVC（RWO）+ gateway sidecar；provisioner 调 K8s API。
- 公开入口 `https://host/u/<opaque-id>/` + 中央 router（动态路由表）；router 剥前缀、重写 cookie Path、透传 WS；单证书。
- 滚动升级（停旧起新，PVC 不动）；每租户指标与告警。
- 备份：CronJob 挂 PVC，restic → S3，定期恢复演练。

### 三期（≤1000）— 弹性

- router 分片；空闲挂起（30 分钟无请求 scale=0）+ 按需唤醒，目标冷启动 p95 < 10s。
- 内容包独立分发（只读 RWX 或镜像卷），减少重复拉取。
- 成本核算与出账；节点容量按"峰值活跃实例 × 单实例规格"规划。

## 7. 冷启动

| 阶段 | 成本 | 优化 |
|---|---|---|
| 容器创建 + 挂卷 | < 2s | 镜像与卷在本机 |
| entrypoint 初始化（首次） | 1–3s | 模板复制；node_modules 已在镜像内 |
| DSH 启动 + profile 装载 | 2–10s | 禁止启动期插件热装 |
| gateway 交换 token | < 100ms | 启动即完成，不阻塞首个请求 |

首访若实例未就绪，返回 503 + `Retry-After`，前端显示"正在启动"页轮询，避免空白等待。
