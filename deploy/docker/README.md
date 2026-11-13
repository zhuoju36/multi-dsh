# deploy/docker

用户镜像（DSH + gateway）与平台服务镜像。

## 用户镜像

`Dockerfile` 是多阶段构建：`node:24` 里构建 DSH（前端产物必须存在），`node:24-slim` 作为运行层；非 root（UID 10001），`DSH_HOME=/data/dsh-home`、`HOME=/data/home`。

DSH 源码不在本仓库，用 BuildKit 命名上下文传入：

```sh
docker buildx build \
  -f deploy/docker/Dockerfile \
  --build-context dsh=/path/to/deepseek-harness \
  --build-arg DSH_VERSION=0.2.2-rc.2 \
  --build-arg DSH_COMMIT=$(git -C /path/to/deepseek-harness rev-parse --short HEAD) \
  -t multi-dsh/dsh:0.2.2-rc.2 .
```

镜像内布局：

```
/opt/multi-dsh/packages/                 DSH 运行时 + apps/web/dist
/opt/multi-dsh/app/services/gateway/     gateway（零第三方依赖）
/opt/multi-dsh/app/packages/shared/      共享工具；gateway 按相对路径 import
/opt/multi-dsh/docker/entrypoint.sh
/opt/multi-dsh/template/  /opt/multi-dsh/patch/
```

`entrypoint.sh`：首次初始化 `$DSH_HOME` → 后台起 gateway → 前台起 `dsh --profile web --host 127.0.0.1 --port 3080 --no-open` → 把启动行里的 launch token 写入 `/run/dsh/launch-token`（0600），日志中替换为 `token=***` → 透传 SIGTERM/SIGINT。

## 平台镜像

`platform.Dockerfile` 构建 auth 与 llm-gateway，用 `SERVICE` 选择入口：

```sh
docker buildx build -f deploy/docker/platform.Dockerfile --build-arg SERVICE=auth -t multi-dsh/auth:dev .
docker buildx build -f deploy/docker/platform.Dockerfile --build-arg SERVICE=llm-gateway -t multi-dsh/llm-gateway:dev .
```

Compose 会自动构建，通常不需要手动执行。

## 本机验证（无需 Docker）

有已构建的 DSH checkout 时，直接跑冒烟脚本：

```sh
DSH_CHECKOUT=/path/to/deepseek-harness bash scripts/smoke-gateway.sh
```

预期：gateway 健康检查 200、首请求 303 换 cookie、带 cookie 返回 DSH 首页、日志中无明文 token。

## 约束

- 镜像里必须已有前端产物，否则 `dsh web` 启动失败。
- `--host` 只能是具体地址（`127.0.0.1`），`0.0.0.0` 会被拒绝。
- 一期没有域名：不需要 `--public-url` / `--trusted-host`；宿主端口映射使浏览器侧 Host 为 `127.0.0.1:<port>`，loopback 天然通过 DSH 栅栏。
- token 只出现在 `/run/dsh`（tmpfs）与进程内存，不写日志、不落 `/data`。
- gateway 必须用与后续请求相同的 `Host` 完成 token 交换（见 [docs/architecture.md](../../docs/architecture.md) §5 第 9 条）。
- `read_only: true` 下依赖 tmpfs `/tmp`、`/run/dsh`，且 `HOME` 指向 `/data/home`（见租户编排）。
