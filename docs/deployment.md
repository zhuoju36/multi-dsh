# 部署（一期：Docker Compose）

一期单机、≤10 用户：平台两个服务 + PostgreSQL 跑在 `compose.platform.yml`，每个租户一个独立 Compose project。只发布到 `127.0.0.1`，不接公网。

## 1. 镜像

### 用户镜像（DSH + gateway）

DSH 源码不 vendored，用 BuildKit 命名上下文传入：

```sh
docker buildx build \
  -f deploy/docker/Dockerfile \
  --build-context dsh=/path/to/deepseek-harness \
  --build-arg DSH_VERSION=$(node -p "require('/path/to/deepseek-harness/package.json').version") \
  --build-arg DSH_COMMIT=$(git -C /path/to/deepseek-harness rev-parse --short HEAD) \
  -t multi-dsh/dsh:0.2.2-rc.2 .
```

镜像布局（相对路径必须与仓库一致，gateway 直接按相对路径 import shared）：

```
/opt/multi-dsh/packages/               DSH 运行时 + 已构建前端（apps/web/dist）
/opt/multi-dsh/app/services/gateway/   零第三方依赖的 gateway
/opt/multi-dsh/app/packages/shared/    logger/config/cookies/ids
/opt/multi-dsh/docker/entrypoint.sh
/opt/multi-dsh/template/   /opt/multi-dsh/patch/
```

- 镜像内必须已有前端产物，否则 `dsh web` 启动失败。
- 非 root（UID 10001）；`/data` 与 `/run/dsh` 在镜像中预建并 chown。
- `HOME=/data/home`，缓存目录指向 `/tmp`，保证 `read_only: true` 下工具仍可写。

### 平台镜像

auth 与 llm-gateway 共用一个 Dockerfile，用 `SERVICE` 选择入口：

```sh
docker buildx build -f deploy/docker/platform.Dockerfile --build-arg SERVICE=auth -t multi-dsh/auth:dev .
docker buildx build -f deploy/docker/platform.Dockerfile --build-arg SERVICE=llm-gateway -t multi-dsh/llm-gateway:dev .
```

（Compose 会直接在 `deploy/compose` 下构建，无需手动执行。）

## 2. 卷与路径

| 路径 | 类型 | 内容 | 备份 |
|---|---|---|---|
| `/data` | **bind mount**：`/srv/multi-dsh/volumes/<id>/data` | `dsh-home/`（含 `attachments/v1`、`sessions/`）+ `projects/` | 是 |
| `/data/home` | 同上（`HOME`） | shell 历史、工具配置；缓存被指到 `/tmp` | 是 |
| `/tmp`、`/run/dsh` | tmpfs | 缓存、launch token | 否 |
| `/opt/multi-dsh` | 镜像内只读 | DSH 运行时、gateway、模板、部署 patch | 否 |

- 每个租户一个宿主目录；不要用 Docker named volume（overlay2 无法限容）。
- 宿主数据盘建议 XFS + 每租户 project quota（默认 20 GiB）；见 [tenancy.md](tenancy.md)。
- provisioner 负责 `mkdir`、`chown 10001` 和写 `tenant.env`；XFS project quota 目前在开通后由运维设置（后续可加 `--quota` 参数）。

## 3. 启动序列

```
entrypoint.sh
 1. 校验/初始化 /data/dsh-home（可选模板复制）
 2. 清空 /run/dsh/launch-token
 3. 后台起 gateway（:8080），它等待 token 文件出现
 4. 前台起 dsh --profile web --host 127.0.0.1 --port 3080 --no-open \
        --patch /opt/multi-dsh/patch/deploy.yml
      → 解析启动行，token 写入 /run/dsh/launch-token（0600）
      → 日志中 token 被替换为 ***
 5. 前台等待 dsh 退出并透传信号
```

- `--host` 必须是具体地址（`127.0.0.1`），`0.0.0.0` 会被拒绝。
- 一期无域名/TLS，不需要 `--public-url` / `--trusted-host`：宿主端口映射使浏览器侧 `Host` 为 `127.0.0.1:<port>`，loopback 天然通过 DSH 的 Host 栅栏。
- 部署级配置走 `--patch`（argv 层），不进用户可写区；空 patch 文件会让 dsh 启动失败，entrypoint 只在文件非空时传入。
- launch token 只存在 tmpfs 与进程内存；容器日志里已脱敏。

## 4. Compose 编排

### 平台

```sh
cd deploy/compose
cp .env.example secrets/platform.env   # 填 POSTGRES_PASSWORD / PLATFORM_API_KEY，chmod 600
docker compose -f compose.platform.yml --env-file secrets/platform.env up -d
```

- `postgres`：`/srv/multi-dsh/pgdata`，仅 `127.0.0.1:5432`，供宿主机 provisioner/迁移。
- `auth`：内部 `127.0.0.1:18080`，只读根文件系统 + tmpfs，健康检查 `/healthz`。
- `router`：公开入口 `127.0.0.1:18000`（host network），`/u/<id>/` → 租户 gateway，其余 → auth；负责剥前缀、cookie Path 重写、WebSocket。
- `llm-gateway`：**不发布端口**，只在 `control`（连 PG）与 `edge`（供租户）网络上。
- `hub`：**宿主机 systemd 服务**（不在 Compose 里），监听 `/srv/multi-dsh/run/hub.sock`；auth 容器把该目录挂到 `/run/multi-dsh`，用 `HUB_TOKEN` 调它创建/启停实例。
- `minio`：restic 的 S3 兼容备份目标，`127.0.0.1:9000`（S3）/`127.0.0.1:9001`（控制台）；`minio-init` 一次性创建 `multi-dsh-backup` bucket。
- `edge` 网络固定名为 `multi-dsh-edge`，租户 project 以 external 方式加入。

### 租户

每个租户一个 env 文件（`deploy/compose/tenants/<id>.env`，0600）和一个 Compose project：

```sh
docker compose -p dsh-<id> -f deploy/compose/compose.tenant.yml \
  --env-file deploy/compose/tenants/<id>.env up -d --wait
```

- 容器名 `dsh-<id>`；`read_only: true`，`/tmp` 1 GiB tmpfs、`/run/dsh` 1 MiB tmpfs（`uid=10001,gid=10001,mode=700`，否则 entrypoint 写不了 token）。
- `NARB_DISABLE_NATIVE_CACHE=1`：Docker tmpfs 默认 `noexec`，DSH 的原生插件缓存到 `/tmp` 后会被 dlopen 拒绝；禁用缓存直接从镜像加载。
- 端口只映射 `127.0.0.1:<HOST_PORT>:8080`；DSH 的 3080 不发布。
- `HOME=/data/home`，`XDG_CACHE_HOME`/`NPM_CONFIG_CACHE`/`PIP_CACHE_DIR` 指向 `/tmp`。
- 资源默认 limit 2 vCPU / 2 GiB、request 0.5 vCPU / 1 GiB；大附件用户给 4 GiB。
- `restart: unless-stopped`、json-file 日志轮转（10m × 3）。
- 备份 cron 以 root 运行（volume 属主是容器 UID 10001，普通用户读不了）。

### 控制面（Hub）

```sh
sudo install -m 0644 deploy/systemd/multi-dsh-hub.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now multi-dsh-hub
systemctl status multi-dsh-hub
```

`HUB_TOKEN` 在 `secrets/platform.env`（host-setup 自动生成）；Hub 以 `hzj` 运行，依赖 docker 组/socket 权限与 `/srv/multi-dsh`、`deploy/compose` 的写权限。默认 `IDLE_TIMEOUT_MS=0`（不做空闲回收）；开启前需重新构建用户镜像，让 gateway 带 `/internal/activity`。

### 开通/删除/轮换

用户自助注册（推荐）：管理员生成一次性邀请码，用户打开链接自设用户名/密码，auth 调 Hub 建实例并自动登录。

```sh
node services/auth/src/cli.mjs invite create --hours 72
# → http://127.0.0.1:18000/register?code=inv_...
node services/auth/src/cli.mjs reset create --username alice   # 忘记密码
```

管理员代开（break-glass，需要 root 做目录 chown）：

```sh
export DATABASE_URL=postgres://multi_dsh:***@127.0.0.1:5432/multi_dsh
export DSH_IMAGE=multi-dsh/dsh:0.2.2-rc.2

sudo -E node services/provisioner/src/cli.mjs create --username alice
sudo -E node services/provisioner/src/cli.mjs status
sudo -E node services/provisioner/src/cli.mjs rotate-key --user usr_...
sudo -E node services/provisioner/src/cli.mjs delete --user usr_...
node services/provisioner/src/cli.mjs usage --month 2026-11
```

`create` 会把密码与虚拟 key 各打印一次；数据库只存哈希。删除只停容器、释放端口、吊销 key，数据目录保留，按保留策略人工清理。

> provisioner 需要把租户数据目录 chown 给容器内的 UID 10001。以 root 运行时自动创建并 chown；以普通用户运行时（`ALLOW_NONROOT=1`）必须**预先**创建 `/srv/multi-dsh/volumes/<user_id>/data` 并 chown 10001，否则 Docker 会以 root 创建绑定目录，DSH 写不了 `/data`。

## 5. 网络与出口

```
浏览器 127.0.0.1:<port> → gateway :8080 → DSH 127.0.0.1:3080（同容器）
浏览器 127.0.0.1:18000（统一登录）→ auth → 按身份跳 /u/<id>/
租户 dsh → llm-gateway:18090（edge 网络）→ https://api.deepseek.com
```

- 租户容器只加入 `edge`；`control`（PG）不对租户可达。
- llm-gateway 是唯一持有平台 key 的进程。
- 租户 egress 一期全放行（DSH 工具需要联网）；二期再收敛为出口代理白名单。

### 对外访问（当前不支持）

- 所有服务只绑定 `127.0.0.1`；浏览器必须跑在这台机器上。
- 现在所有租户共用一个入口：`http://127.0.0.1:18000/`，登录后自动跳 `/u/<id>/`；远程用 SSH 隧道只转发 18000：
  `ssh -N -L 18000:127.0.0.1:18000 user@host`。
- 不要把 18000 直接发布到 `0.0.0.0`：当前无 TLS，cookie/token 明文；正式对外需要 TLS 反代（路径前缀保持不变）。

## 6. 参数表

配置与密钥文件：

| 文件 | 内容 | 谁读 |
|---|---|---|
| `/srv/multi-dsh/secrets/platform.env` | PG/MinIO 密码、`PLATFORM_API_KEY`、`UPSTREAM_BASE_URL`、`HUB_TOKEN`、`AUTH_*`、`DSH_IMAGE`、`TENANT_*`、`IDLE_TIMEOUT_MS` | compose、Hub、auth CLI |
| `/srv/multi-dsh/secrets/restic.env` | 备份仓库、MinIO 凭据、restic 密码文件 | 备份 cron |
| `deploy/compose/tenants/<id>.env` | 每租户端口、数据目录、虚拟 key、资源上限 | 租户 compose（Hub/provisioner 自动生成） |
| PostgreSQL `users` 表 | 用户密码哈希（Argon2id） | auth |

平台（`secrets/platform.env`）：

| 参数 | 说明 |
|---|---|
| `POSTGRES_PASSWORD` | 必填 |
| `POSTGRES_DATA_DIR` | 默认 `/srv/multi-dsh/pgdata` |
| `AUTH_PUBLIC_URL` / `PUBLIC_ORIGIN` | 默认 `http://127.0.0.1:18000`（router 入口） |
| `SESSION_TTL_HOURS` | 默认 12 |
| `UPSTREAM_BASE_URL` | 默认 `https://api.deepseek.com/anthropic`，必须带 `/anthropic` |
| `PLATFORM_API_KEY` | 必填，只进 llm-gateway |
| `MONTHLY_QUOTA_TOKENS` | 0 = 不限 |
| `DSH_IMAGE` / `DSH_VERSION` | 新租户使用的镜像与版本标注 |
| `TENANT_CPUS` / `TENANT_MEMORY` | 新租户默认资源 |
| `AUTH_INTERNAL_URL` / `AUTH_PUBLIC_URL` | 租户 gateway 的内网/浏览器地址 |
| `IDLE_TIMEOUT_MS` | Hub 空闲回收阈值，0 = 关闭 |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | MinIO 凭据，同时供 restic 使用 |
| `MINIO_DATA_DIR` | 默认 `/srv/multi-dsh/minio` |
| `MINIO_PORT` / `MINIO_CONSOLE_PORT` | 默认 9000 / 9001，仅 loopback |

租户（provisioner 渲染的 `<id>.env`）：

| 参数 | 说明 |
|---|---|
| `USER_ID` / `HOST_PORT` | 租户与端口，registry 为唯一来源 |
| `USER_HOST` | `127.0.0.1:<HOST_PORT>` |
| `DATA_DIR` | 宿主数据目录 |
| `TENANT_KEY` | 租户虚拟 key（`sk-mdsh-…`） |
| `DSH_IMAGE` / `DSH_VERSION` | 镜像 tag 与版本记录 |
| `AUTH_INTERNAL_URL` / `AUTH_PUBLIC_URL` | gateway 双地址 |

## 7. 与二期 K8s 的对应

| 能力 | Compose（一期） | K8s（二期） |
|---|---|---|
| 实例 | 一容器一用户 | 一 Pod 一用户（gateway sidecar） |
| 持久化 | 宿主 bind mount | PVC |
| 入口 | 宿主端口 | router + 路径前缀 + TLS |
| 隔离 | 网络分离 + 只读根文件系统 | NetworkPolicy + Pod 安全上下文 |
| 升级 | 改镜像 tag 后重建容器 | 滚动替换 |
| 备份 | 宿主 cron + restic | CronJob + restic |
