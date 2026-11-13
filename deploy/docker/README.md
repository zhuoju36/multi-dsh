# deploy/docker

DSH 运行镜像与容器入口（每用户容器）。

## 已实现（原型）

- `Dockerfile` — 多阶段：`node:24` 构建（`pnpm install && pnpm run build`），`node:24-slim` 运行；非 root（UID 10001），`DSH_HOME=/data/dsh-home`，`WORKDIR /data/projects`，HEALTHCHECK 打 gateway `/healthz`。
- `entrypoint.sh` — 首次初始化 `/data/dsh-home`（可选模板复制）→ 后台起 gateway → 前台起 `dsh --profile web --host 127.0.0.1 --port 3080 --no-open` → 解析启动行、把 token 写入 `/run/dsh/launch-token`（0600）→ 透传 SIGTERM/SIGINT。
- `template/dsh-home/` — 首次启动复制到 DSH_HOME 的初始内容（当前只有 `.gitkeep`；`dsh` 会自行初始化 `profiles/web`）。
- `patch/README.md` — 部署 patch 说明；`entrypoint` 只在 patch 文件非空时才传 `--patch`（空 patch 会让 `dsh` 启动失败）。

## 构建

DSH 源码不在本仓库，用 BuildKit 命名上下文传入：

```sh
docker buildx build \
  -f deploy/docker/Dockerfile \
  --build-context dsh=/path/to/deepseek-harness \
  -t multi-dsh/dsh:dev .
```

## 本地验证（无需 Docker）

本机有已构建的 DSH checkout 时，可以直接跑 entrypoint：

```sh
DSH_HOME=/tmp/mdsh-home RUN_DIR=/tmp/mdsh-run TOKEN_FILE=/tmp/mdsh-run/launch-token \
LISTEN_PORT=8097 DSH_WEB_PORT=3097 USER_HOST=127.0.0.1:8097 TENANT_ID=dev \
DSH_COMMAND="node /path/to/deepseek-harness/apps/cli/lib/bin.js" \
GATEWAY_ENTRY=$PWD/services/gateway/server.mjs \
TEMPLATE_DIR=$PWD/deploy/docker/template/dsh-home \
PATCH_FILE=/tmp/nonexistent-patch.yml \
bash deploy/docker/entrypoint.sh
```

预期：日志出现 `dsh web: http://127.0.0.1:3097/?token=…`、`launch token captured`；随后

```sh
curl -c jar -b jar -L http://127.0.0.1:8097/   # 200 + 首页 HTML
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8097/healthz   # 200
```

## 约束

- 镜像里必须已有前端产物，否则启动失败。
- `--host` 只能是具体地址（`127.0.0.1`），`0.0.0.0` 会被拒绝。
- 一期没有域名：不需要 `--public-url` / `--trusted-host`。
- token 只出现在 `/run/dsh`（建议 tmpfs）与进程内存，不写日志、不落盘到 `/data`。
- gateway 必须用与后续请求相同的 `Host` 完成 token 交换（见 `docs/architecture.md` §5 第 9 条）。
