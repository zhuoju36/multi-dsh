# 运维（一期）

## 1. 备份与恢复

### 目标

| 层级 | RPO | RTO | 手段 |
|---|---|---|---|
| 单用户数据 | ≤ 24h | ≤ 30 min | restic 快照 → S3 兼容对象存储 |
| 租户注册表（PG） | ≤ 5 min | ≤ 15 min | `pg_dump` + WAL 归档（或每小时全量） |
| 镜像与内容包 | 0 | — | 镜像仓库按 digest 保留 |

### 内容

- 每个 `data-<id>` 卷：`/data/dsh-home` + `/data/projects`。`cache/` 可排除（可再生）。
- `.credentials.yaml` 含用户虚拟 key 与 DSH cookie 签名密钥：必须加密（restic 自带）且桶策略最小权限。
- 快照 tag 写入：`user_id`、镜像 digest、内容包版本、时间——恢复时才知道该配哪个版本。

### 一致性

DSH 会话是追加式 JSONL（Zstd 帧、尾部撕裂可恢复），文件级快照通常安全：

- 优先 `docker compose stop dsh-<id>` 后快照（脚本化，可接受短暂停机）；
- 或在低写入窗口直接快照，接受极小概率的尾部修复（DSH 启动时自行恢复）。
- 恢复后**不要**手工拼接 JSONL；让 DSH 做尾部恢复与格式迁移。

### 恢复演练

- 每季度抽 1 个租户：恢复到临时卷 → 起一个临时容器 → 能登录、看到历史会话、继续对话。
- 记录耗时与缺失项；不达 RTO 就调整保留策略与并发。

## 2. 计量与账单（平台统一 key）

计量点在 `llm-gateway`，不在 DSH 里：

- DSH 只持有租户虚拟 key；网关校验后注入平台真 key，并记录每次请求的 `tenant_id / model / input / output / cache_read / cache_write / ts`。
- 按租户按月汇总 token → 出账或内部结算；超配额直接 429。
- DSH 自带的 `token-meter` 是重放估算，只用于上下文压力显示，**不作为账单口径**；`session-telemetry-otel` 默认仅导出显式反馈，也不适合计量。
- 网关日志不记录 prompt/response 正文，只记录用量与请求元数据。

对账手段：DSH 会话日志里的 provider usage 可抽样核对网关记录；差异超过 1% 视为故障排查。

## 3. 升级与回滚

### 升级对象

1. DSH 镜像（DSH 运行时 + 前端）
2. 内容包 / 技能源（`/opt/multi-dsh`）
3. 平台组件（auth / llm-gateway / gateway）
4. 部署级 `cordis.patch.yml`

### 流程

```
备份 → 单租户金丝雀（内部账号）→ 观察 24h（错误率、启动耗时、计量差异）
     → 逐租户替换容器（改镜像 digest，卷不动）→ 每批可回滚
```

命令形态：`docker compose up -d --no-deps --build dsh-<id>`（或改 `tenants/<id>.env` 中的镜像 tag 后重建）。

### 回滚风险（必读）

- **会话格式迁移可能单向**：新版本把会话升级到更高 `session-format`，旧镜像能否读需按版本验证；回滚前确认，否则从升级前快照恢复。
- 用户在升级期间装了不兼容插件：DSH 会跳过该 bundle（`skippedBundles`），不会崩溃；升级后要检查该字段。
- 回滚后同步 registry 的 `dsh_version`，避免后续判断错误。

## 4. 可观测性

| 信号 | 来源 | 用途 |
|---|---|---|
| 容器健康 / 重启次数 | Compose healthcheck + Docker 事件 | 故障发现 |
| 每租户请求数 / 延迟 | gateway | 定位实例问题 |
| 模型 token 用量 | llm-gateway | 计费、限速 |
| 卷使用率 | 宿主 `df` / node_exporter | 80% 告警 |
| 启动耗时（分段） | entrypoint 打点 | 冷启动优化 |
| 备份成功/耗时/大小 | restic 任务 | RPO 保障 |

原则：

- 会话正文、附件、凭证不进日志；只记录 id、大小、耗时、错误码。
- DSH 启动行含 launch token：日志采集必须过滤 `?token=`，或只保留前缀与主机名。
- 一期可用 `docker logs` + 简单脚本 + 一个 Prometheus node_exporter；不引入重型栈。

## 5. 故障处理 Runbook

| 现象 | 判断 | 处理 |
|---|---|---|
| 页面打不开 / 502 | 容器未起或 gateway 未就绪 | `docker compose ps`；看 healthcheck 与日志；重建容器 |
| 登录后又回登录页 | 平台 cookie 未生效（`127.0.0.1` 上被浏览器策略拒绝？） | 检查 cookie 属性与时钟；确认 `next` 未被拦 |
| 401 循环 | DSH cookie 失效 / gateway 未拿到 token | 看 `/run/dsh/launch-token` 是否生成；重启后重新交换 |
| 403 租户不匹配 | 平台 cookie 的 user_id ≠ 实例租户 | 正常保护行为；检查是否 URL 误发 |
| 页面空白 | 前端产物缺失/损坏 | 校验镜像；看启动是否停在构建提示 |
| 崩溃循环 | 卷满、权限、profile 损坏 | `df -h`；chown；从备份恢复 profile；万不得已重置 profile（会丢用户插件） |
| 卷写满 | 会话/附件增长 | 扩容卷；清 cache；提示用户导出附件 |
| 模型调用全部 429 | 租户配额用尽 / 平台 key 限额 | 查 llm-gateway 配额与上游余额 |
| 计量对不上 | 网关与 DSH 记录差异 | 抽查 usage、检查是否绕过网关直连 |

**升级前检查单**：备份成功 → 金丝雀通过 → 旧镜像 digest 已保留 → 会话格式兼容性已确认 → 通知维护窗口。

## 6. 安全基线（一期）

- [ ] 用户端口只绑 `127.0.0.1`；确认 `ss -lntp` 无 `0.0.0.0` 暴露。
- [ ] 平台 key 只在 llm-gateway；DSH 容器只有虚拟 key，可单独吊销。
- [ ] 一用户一卷；容器只读根文件系统 + `no-new-privileges` + drop ALL。
- [ ] 平台会话 cookie：`HttpOnly`、`SameSite=Lax`、有限期、可吊销；登录限流。
- [ ] 登录页与 `next` 参数做 registry 白名单校验，防开放重定向。
- [ ] `.credentials.yaml` 不进日志、不进镜像、不进共享路径。
- [ ] 卷与对象存储静态加密；restic 加密并限制桶权限。
- [ ] 审计：登录、开通、删除、配额变更、恢复操作留痕。
- [ ] **已知缺口**：一期无 TLS。仅限本机/受控内网；任何对外暴露前必须先补 TLS 与访问控制。

## 7. 容量与成本

- 每租户常驻 = 0.5C/1GiB request、2C/2GiB limit + 20GiB 卷（实测空载 375 MB，见 [capacity.md](capacity.md)）。
- 10 用户：request 合计约 6C/8GiB，主机推荐 16C/32GiB/500GB；不要按 limit 之和（20C/20GiB）买机器。
- 单机需留出 30% 余量给 DSH 瞬时峰值（构建、测试类工具）。
- 每季度复盘：单实例内存峰值、卷增长速率、冷启动分布；三者决定二期规格。
- 备份成本 ≈ 全量 × 保留代数；cache 排除后通常只有会话与工作区。
