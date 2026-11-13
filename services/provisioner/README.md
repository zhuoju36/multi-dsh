# services/provisioner

租户与实例的生命周期管理（一期是宿主机 CLI + registry 写入）。

## 命令

```sh
export DATABASE_URL=postgres://multi_dsh:***@127.0.0.1:5432/multi_dsh
export DSH_IMAGE=multi-dsh/dsh:0.2.2-rc.2

node src/cli.mjs create --username alice [--user usr_x] [--password ...] [--image ...]
node src/cli.mjs delete --user usr_...
node src/cli.mjs rotate-key --user usr_...
node src/cli.mjs usage [--month 2026-11]
node src/cli.mjs status
```

## create

1. `users` 落库（Argon2id 密码哈希；密码或虚拟 key 只在终端打印一次）。
2. 事务内分配端口（`ports` 表，`FOR UPDATE SKIP LOCKED`；释放后冷却 30 天）。
3. 生成租户虚拟 key（只存哈希）。
4. 创建宿主数据目录 `/srv/multi-dsh/volumes/<id>/data`（root 执行时 chown 10001；XFS project quota 由运维随后设置）。
5. 渲染 `deploy/compose/tenants/<id>.env`（0600）。
6. `docker compose -p dsh-<id> --env-file … up -d --wait`。
7. 置 `ready`、写审计。失败时置 `failed`，排查后 `delete --user`。

## delete / rotate-key

- delete：`compose down` → 释放端口 → 吊销 key → 置 `deleted` → 禁用账号；数据目录保留，按保留策略人工清理。
- rotate-key：吊销旧 key → 新 key 写入 env → `up -d --wait --force-recreate`（容器重启，短暂中断）。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `DATABASE_URL` | 必填 | PostgreSQL |
| `DATA_ROOT` | `/srv/multi-dsh/volumes` | 租户数据根目录 |
| `DSH_IMAGE` | `multi-dsh/dsh:dev` | 用户镜像 tag |
| `DSH_VERSION` | 空 | 写入 registry 与 env 的版本标注 |
| `AUTH_INTERNAL_URL` / `AUTH_PUBLIC_URL` | `http://auth:18080` / `http://127.0.0.1:18000` | 传给租户 |
| `TENANT_COMPOSE_FILE` | 仓库内 `deploy/compose/compose.tenant.yml` | 租户编排 |
| `TENANT_ENV_DIR` | 仓库内 `deploy/compose/tenants` | 租户 env 目录 |
| `DOCKER_BIN` | `docker` | |
| `MONTHLY_QUOTA_TOKENS` | `0` | 写入租户 env 的配额标注 |

## 测试

`pnpm --filter @multi-dsh/provisioner test`：key/env 渲染、compose 参数、月份区间、Argon2 哈希。
