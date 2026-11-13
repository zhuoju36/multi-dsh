# deploy/compose

一期唯一编排：平台一套 Compose，每个租户一个独立 Compose project。

## 文件

| 文件 | 用途 |
|---|---|
| `compose.platform.yml` | `postgres` + `auth` + `llm-gateway` + `router` + MinIO；创建 `multi-dsh-edge` 网络 |
| `compose.tenant.yml` | 单租户模板，用 `-p dsh-<id>` 运行 |
| `.env.example` | 平台环境变量样例，复制到 `secrets/platform.env`（0600） |
| `tenants/<id>.env` | Hub/provisioner 渲染的租户参数（端口、公开路径、虚拟 key），不入库 |
| `scripts/backup.sh` | 停租户 → `pg_dump` → restic → 启租户 → 保留策略 |
| `scripts/restore.sh` | 从 restic 恢复单个租户到暂存目录 |

## 平台

```sh
cd deploy/compose
cp .env.example secrets/platform.env    # 填 POSTGRES_PASSWORD、PLATFORM_API_KEY，chmod 600
docker compose -f compose.platform.yml --env-file secrets/platform.env up -d
```

- `router` 发布公开入口 `127.0.0.1:18000`（host network），把 `/u/<id>/` 转发到租户、其余转发 auth。
- `auth` 内部 `127.0.0.1:18080`，并挂载 `/srv/multi-dsh/run` 以访问 Hub 的 Unix socket；`HUB_TOKEN` 在 `secrets/platform.env`。
- Hub 是宿主机 systemd 服务（`deploy/systemd/multi-dsh-hub.service`），不在本 compose 里。
- `llm-gateway` 不发布端口，只加入 `control`（连 PG）与 `edge`（供租户）。
- `postgres` 发布 `127.0.0.1:5432`，仅供宿主机 provisioner / 迁移。

## 租户

```sh
docker compose -p dsh-<id> -f compose.tenant.yml \
  --env-file tenants/<id>.env up -d --wait
```

`tenants/<id>.env` 由 Hub/provisioner 生成，包含 `USER_ID`、`HOST_PORT`、`DATA_DIR`、`TENANT_KEY`、`TENANT_PATH`、`DSH_PUBLIC_URL` 等；租户端口只映射到 `127.0.0.1`。

注意：`env_file` 不参与 `${}` 插值，所以必须用 `--env-file` 传租户变量。

## 开通与运维

```sh
export DATABASE_URL=postgres://multi_dsh:***@127.0.0.1:5432/multi_dsh
node ../../services/provisioner/src/cli.mjs create --username alice
node ../../services/provisioner/src/cli.mjs status
node ../../services/provisioner/src/cli.mjs usage --month 2026-11
```

备份：

```sh
RESTIC_REPOSITORY=s3:https://... RESTIC_PASSWORD_FILE=/srv/multi-dsh/secrets/restic.pass \
  bash scripts/backup.sh
```

## 硬约束

- 用户端口只映射 `127.0.0.1`，不发布 DSH 的 3080。
- 公开入口只有 router（`127.0.0.1:18000`）；租户端口不直接暴露。
- 每租户一个宿主数据目录（bind mount），不用 named volume。
- 平台真 key 只出现在 llm-gateway 的环境里。
- 一期无 TLS：不监听 `0.0.0.0`，不接公网。
