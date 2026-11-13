# 部署（一期：Docker Compose）

## 1. 镜像

```dockerfile
# 构建阶段：产出 DSH 运行时与 Web 前端
FROM node:24-slim AS build
WORKDIR /src
COPY . .
RUN corepack enable && pnpm install --frozen-lockfile && pnpm run build

# 运行阶段
FROM node:24-slim
RUN useradd -u 10001 -m dsh
COPY --from=build /src /opt/multi-dsh/packages
COPY content/ /opt/multi-dsh/content/
COPY skills-src/ /opt/multi-dsh/skills-src/
COPY deploy/patch/ /opt/multi-dsh/patch/
COPY deploy/template/dsh-home/ /opt/multi-dsh/template/dsh-home/
COPY deploy/docker/entrypoint.sh /usr/local/bin/
USER 10001
ENV DSH_HOME=/data/dsh-home
WORKDIR /data/projects
EXPOSE 8080
HEALTHCHECK CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
```

要点：

- 镜像内**必须**已构建前端，否则 `dsh web` 启动即失败。
- 非 root（UID 10001）；卷属主由 init 步骤 chown 一次。
- 内容包版本单独记录（`/opt/multi-dsh/content/VERSION`），便于区分"代码没变但行为变了"。
- 镜像用 `@sha256` digest 固定；禁止 `:latest`。

## 2. 卷与路径

| 路径 | 类型 | 内容 | 备份 |
|---|---|---|---|
| `/data` | named volume `data-<id>` | `dsh-home/` + `projects/` | 是 |
| `/opt/multi-dsh` | 镜像内只读 | packages、内容包、技能源、模板、部署 patch | 否（可再生） |
| `/run/dsh` | 容器内 tmpfs | `launch-token`（entrypoint 写、gateway 读） | 否 |

一个用户一个卷，禁止共享。`/data` 初始化：entrypoint 检测空卷时 `cp -a /opt/multi-dsh/template/dsh-home/. /data/dsh-home/` 并按需 chown。

## 3. 启动序列

```
entrypoint.sh
 1. 校验 /data 可写；首次启动复制模板并 chown
 2. 清空 /run/dsh/launch-token
 3. 后台拉起 gateway（:8080），它等待 token 文件出现
 4. 启动 dsh --profile web --host 127.0.0.1 --port 3080 --no-open \
        --patch /opt/multi-dsh/patch/deploy.yml
      → stdout 同时写容器日志与解析管道；命中 `dsh web:` 行 → 写 /run/dsh/launch-token
      → entrypoint 留在前台等待 dsh 退出并透传信号（不能用 exec + 管道）
```

说明：

- `--host` 必须给具体地址；`0.0.0.0` 会被 DSH 拒绝。
- 一期没有域名，**不需要** `--public-url` / `--trusted-host`：监听 URL 即 `http://127.0.0.1:3080`，Host 是 `127.0.0.1:<宿主端口>`，loopback 天然通过 Host 栅栏。
- 部署级配置走 `--patch`（argv 层最后应用、优先级最高），不进用户可写区。
- token 捕获是零改动方案；二期可加只读 patch 改为读 `DSH_LAUNCH_TOKEN_FILE`。
- DSH cookie 签名密钥在 `.credentials.yaml`，容器重启后旧 cookie 仍有效；token 每次重启变化，只影响首次交换。

## 4. Compose 编排

```yaml
# deploy/compose/compose.yml（示意）
services:
  postgres:
    image: postgres:16
    volumes: [pgdata:/var/lib/postgresql/data]
  auth:
    build: ../../services/auth
    environment: [DATABASE_URL, SESSION_SECRET]
    ports: ["127.0.0.1:18080:18080"]
  llm-gateway:
    build: ../../services/llm-gateway
    environment: [DATABASE_URL, UPSTREAM_BASE_URL=https://api.deepseek.com, PLATFORM_API_KEY]
    ports: ["127.0.0.1:18090:18090"]
  dsh-usr_abc:
    build: ../../deploy/docker
    environment:
      - USER_ID=usr_abc
      - USER_HOST=127.0.0.1:18001
      - AUTH_URL=http://auth:18080
      - DEEPSEEK_BASE_URL=http://llm-gateway:18090
      - DEEPSEEK_API_KEY=${TENANT_KEY_USR_ABC}
    volumes:
      - data-usr_abc:/data
    ports: ["127.0.0.1:18001:8080"]   # 只映射到本机
    read_only: true
    tmpfs: [/tmp]
    security_opt: [no-new-privileges:true]
    cap_drop: [ALL]
    deploy:
      resources:
        limits: { cpus: "2", memory: 2g }      # 实测空载 375 MB，见 docs/capacity.md
        reservations: { cpus: "0.5", memory: 1g }

volumes:
  pgdata:
  data-usr_abc:
```

- 每个用户一个 `services` 条目 + 一个 `tenants/<id>.env`；`provisioner` 渲染后 `docker compose up -d dsh-<id>`。
- 只有 gateway 的 8080 映射到宿主，且绑定 `127.0.0.1`；DSH 的 3080 不发布。
- `read_only: true` + `tmpfs: /tmp`；`/data` 是唯一可写卷。
- 平台 key 只在 `llm-gateway` 环境里；DSH 容器只拿到租户虚拟 key。

## 5. 网络与出口

```
宿主 127.0.0.1:<user_port>  →  gateway :8080  →  127.0.0.1:3080（同容器内）
dsh → llm-gateway:18090（Compose 网络）→ 上游 api.deepseek.com
```

- 用户端口只绑 `127.0.0.1`：本机可用，局域网不可达。
- 容器 egress 需要：`llm-gateway`、DNS，以及 DSH 工具可能访问的外网（抓取类）。一期可全放行，二期加出口代理白名单。
- 不把 DSH 端口暴露到任何其他接口。

## 6. 参数表

| 参数 | 取值 | 来源 | 说明 |
|---|---|---|---|
| `DSH_HOME` | `/data/dsh-home` | env（必须） | 不能放进 `.env` |
| `USER_ID` | `usr_…` | registry → env | 容器名/卷名/日志标识 |
| `USER_HOST` | `127.0.0.1:18001` | registry → env | gateway 生成回跳与 cookie 校验 |
| `DEEPSEEK_BASE_URL` | `http://llm-gateway:18090` | env | DSH 的内置环境变量，支持自定义端点 |
| `DEEPSEEK_API_KEY` | 租户虚拟 key | registry → env | 真 key 不进 DSH 容器 |
| `AUTH_URL` | `http://auth:18080` | env | 登录跳转与会话校验 |

## 7. 与二期 K8s 的对应

| 能力 | Compose（一期） | K8s（二期） |
|---|---|---|
| 实例 | 一容器一用户 | 一 Pod 一用户（gateway sidecar） |
| 持久化 | named volume | PVC |
| 入口 | 宿主端口 | router + 子域 + TLS |
| 隔离 | 端口不发布 + Docker 默认 | NetworkPolicy + Pod 安全上下文 |
| 升级 | 改镜像 digest 后重建容器 | 滚动替换 |
| 备份 | 宿主 cron + restic | CronJob + restic |

一期把 `deploy/k8s/` 保持为空骨架，避免同时维护两套编排。
