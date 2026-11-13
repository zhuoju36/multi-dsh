# 架构设计

## 1. 目标与非目标

**目标**

- 每个用户获得独立的 DSH Web 会话、独立文件（工作区、附件、技能）、独立凭证。
- 用户之间不共享可写状态；一个用户的崩溃、超额、误删不影响其他用户。
- 开通、备份、升级、回收可脚本化、可重复、可审计。
- DSH 按官方发行版使用，不为多租户改核心；一期不引入 K8s、域名、TLS。

**非目标（一期）**

- 不做"一进程服务多用户"；不在 DSH 内做租户隔离。
- 不做域名、通配证书、多节点编排、空闲挂起。
- 不做公网暴露；一期只在本机或受控内网使用。

## 2. 组件（一期）

| 组件 | 形态 | 职责 | 状态 |
|---|---|---|---|
| `dsh-<id>` 容器 | 每用户一个 | 容器内跑 gateway + `dsh web`，DSH 绑 loopback | 有状态（卷） |
| `gateway` | 容器内进程（二期拆 sidecar） | 平台会话校验、DSH launch-token 交换、反代 | stateless |
| `auth` | 服务（:18080） | 密码登录、会话签发与校验、限流、审计 | 状态在 PG |
| `registry` | PostgreSQL | 用户、实例、端口、配额、用量 | 持久 |
| `llm-gateway` | 服务（:18090） | 平台真 key 的唯一持有者；租户虚拟 key → 真实上游；按 token 记账与限额 | 状态在 PG/对象存储 |
| `provisioner` | 宿主机脚本/服务 | 开通、重建、删除；写 registry；调 Compose | stateless |

**没有的东西**：负载均衡、router、Ingress、通配证书。一期靠"宿主端口 → 容器"直达。

## 3. 请求链路

### 3.1 登录

```
GET http://127.0.0.1:18001/
  → gateway（容器内 :8080）：无平台会话 cookie
  → 302 http://127.0.0.1:18080/login?next=http://127.0.0.1:18001/
  → auth 校验 next 在本 registry 内（防开放重定向）
  → 密码校验（Argon2id）→ 写 PG 会话 → Set-Cookie: mdsh_session=<签名 ID>; HttpOnly; SameSite=Lax; Path=/
  → 302 回 next
```

cookie 是 host-only（`127.0.0.1`），**会带到所有租户端口**。因此 gateway 必须校验两件事：

1. 会话有效；
2. `session.user_id == 本实例的 tenant_id`。

不匹配即 403。这样即使 A 把 B 的 URL 发出去，B 的端口也不会替 A 干活。

### 3.2 首访与 DSH token 交换（关键）

DSH 的 Web 端安全模型（上游事实，`packages/client/connection`）：

- 每个进程启动时**随机生成** launch token，打印带 `?token=` 的 URL；`GET /?token=…` 校验后写**签名 cookie** 并 302 到 `./`。
- cookie 签名密钥存 `$DSH_HOME/.credentials.yaml` 的 `client-connection/browser-session` 记录，**重启后仍有效**（同一 DSH_HOME 复用）。
- cookie 名与签名 audience 绑定"主机名 + 端口"，`Host` 校验只接受 loopback、监听绑定 IP、或 `--trusted-host` 列出的 authority；未认证 401，Host/Origin 不符 403。
- 一期监听 `127.0.0.1:3080`、Host 为 `127.0.0.1:<宿主端口>` → **loopback 天然被接受，不需要 `--trusted-host`**。

gateway 的动作（每个浏览器各一次）：

1. 平台会话校验通过。
2. 读 `/run/dsh/launch-token`（entrypoint 从 `dsh web:` 启动行捕获写入）。
3. 本地 `GET /?token=…`，`Host` 保持 `127.0.0.1:<宿主端口>`，拿到 `Set-Cookie`。
4. 把 302 + `Set-Cookie` 回给浏览器（`Location` 改写成外部形式），之后只做反代。

> 备选：给 DSH 打一个只读 dist patch，把 token 改为从 `DSH_LAUNCH_TOKEN_FILE` 读取，省掉 stdout 捕获。一期先用捕获（零 patch），patch 作为优化项。

### 3.3 后续请求

浏览器 → `127.0.0.1:<端口>` → gateway → `127.0.0.1:3080`。gateway 必须：保留 `Host`、透传 WebSocket `Upgrade`、不缓冲流式响应（`/api` 与事件流是长连接）。

### 3.4 模型调用链路

```
dsh（容器）── DEEPSEEK_BASE_URL=http://llm-gateway:18090
            ── DEEPSEEK_API_KEY=<租户虚拟 key>
        → llm-gateway：校验虚拟 key → 注入平台真 key → 上游 api.deepseek.com
        → 记录 usage(tenant, model, input/output/cache tokens) → PG
        → 按租户配额限流/拒绝
```

为什么把计量点放在网关而不是 DSH 里：

- DSH 的 `token-meter` 是**重放估算**，用于上下文压力，不是账单口径；`session-telemetry-otel` 默认只导出显式反馈，不适合计量。
- 平台统一 key 意味着额度是共享的，必须在离模型最近的地方拆分归属。
- 网关还能做超限拒绝、异常调用审计。

## 4. 租户隔离模型（一期）

| 维度 | 隔离手段 |
|---|---|
| 进程 | 一用户一容器；DSH 只绑 `127.0.0.1`，由容器内 gateway 访问 |
| 网络 | Compose 默认 bridge；只有 gateway 端口映射到宿主，且只映射到 `127.0.0.1` |
| 存储 | 一用户一 named volume（`/data`）；`/opt/multi-dsh` 只读 |
| 身份 | `auth` 会话 ↔ `users.id` ↔ 容器/端口；日志里只出现不透明 ID |
| 凭证 | 用户模型 key = 网关虚拟 key（可吊销）；DSH_HOME 内的凭证文件不出容器 |
| 运行时 | 非 root、只读根文件系统、drop capabilities、`no-new-privileges` |

一期不做的：同宿主容器间的内核侧信道隔离（依赖 Docker 与内核默认档）。

## 5. DSH 相关事实与约束（部署必读）

1. **`DSH_HOME`** 默认 `~/.dsh`，可被环境变量覆盖；必须用 env（`.env` 里设 `DSH_*` 会被拒绝）。本项目固定 `/data/dsh-home`。
2. **profile 在 `$DSH_HOME/profiles/<name>`**：manifest、`cordis.patch.yml`、`node_modules`。首次 `dsh web` 会从发行版模板自动初始化 `web` profile；**不要**用 `--from-default-profile`（整个替换并删除已装依赖）。
3. **`dsh web --host` 必须是具体 IP**，拒绝 `0.0.0.0`/`::`。一期绑 `127.0.0.1`。
4. **前端必须已构建**：镜像里没有构建产物时启动直接失败。
5. **反代要求**（上游 `docs/user/guide/public-deployments.md`）：保留浏览器侧 `Host`；有前缀则剥掉；透传 WebSocket；TLS 终止时给 cookie 加 `Secure`；只有 mount 根路径做 token 交换。一期无前缀、无 TLS。
6. **cookie 名由 authority 决定**：同一 origin 下多租户会互相覆盖。一期用端口区分（cookie 名含端口），二期必须用子域，永远不要用路径前缀。
7. **会话落盘**：`$DSH_HOME/sessions` 每会话一个追加式 JSONL（Zstd 帧、带校验和、支持撕裂尾部恢复）→ 文件级备份可行；`goal/change` 等进度事件也追加在会话日志里。
8. **升级可能迁移会话格式**：上游有 `session-format` v0→v4 迁移链；新版本读旧数据会自动升级落盘，旧镜像能否读新格式需按版本验证。回滚前确认兼容性，否则从升级前快照恢复。

9. **cookie 的 authority 跟随请求的 `Host`（实测）**：`GET /?token=…` 时 `Host` 是什么，cookie 名与签名 payload 就绑定什么（实测 payload：`{"authority":"127.0.0.1:18001"}`）。所以 gateway 必须在"交换 token"和"后续代理"两个请求上使用**同一个 `Host`**，不一致会稳定 401。另一个坑：Node 的 `fetch()` 会忽略自定义 `Host`（forbidden header），token 交换必须用 `http.request`。

## 6. 关键决策

**D1 一用户一容器。** 隔离边界在容器与卷上，DSH 零改动。代价是每用户最低资源开销。

**D2 一期用端口，二期用子域。** 端口方案零 DNS、零证书，且 DSH cookie 名含端口，不会互相覆盖；子域方案在二期引入 TLS 时落地。二者都不使用路径前缀。

**D3 每容器一个 gateway，而不是集中式入口。** 平台会话与 DSH token 都是逐实例状态；就近访问 loopback 最简单，也不把 10 个实例的 token 集中到一处。二期沿用为 sidecar。

**D4 DSH 绑 loopback。** 明文 HTTP 不出容器；宿主端口只映射到 `127.0.0.1`。

**D5 平台 key 只在 llm-gateway。** DSH 只拿到可吊销的虚拟 key；计量与限额在网关，账单口径唯一。

**D6 部署级配置只读**：`--patch /opt/multi-dsh/patch/deploy.yml`（argv 层，优先级最高），不进用户可写区；用户改自己的 `cordis.patch.yml`。

**D7 一期不引入 router/K8s/服务网格。** 复杂度留给 2、3 期；先保证开通、备份、升级三条链路可靠。

## 7. 未决问题

- 平台会话 cookie 是否需要 `Secure` 分档（内网 HTTP 访问时）？若要支持内网，TLS 需要提前。
- 端口段与端口回收策略：固定映射还是动态分配？删除用户后端口是否复用（影响旧书签与 cookie）？
- llm-gateway 的流式转发实现（SSE 透传、背压、超时）与配额粒度（日/月、按模型）。
- 用户能否自行安装/升级 DSH 插件（profile `node_modules` 写入）？影响升级兼容与支持成本。
