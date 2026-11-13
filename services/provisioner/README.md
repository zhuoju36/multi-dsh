# services/provisioner

租户与实例的生命周期管理。一期是宿主机脚本 + registry 写入；二/三期升级为服务。

一期范围（`deploy/compose/scripts/`）：

- 开通：`users` 落库 → 分配端口（18001–18100，唯一约束）→ 向 llm-gateway 签发虚拟 key → 渲染 `tenants/<id>.env` → `docker compose up -d dsh-<id>` → 等 healthcheck → 置 `ready`。
- 删除：标 `deleting` → 停容器、释放端口（30 天后复用）→ 吊销虚拟 key → 卷保留 7 天 → 到期删除。
- 重建：保留卷，重建容器（镜像升级、故障恢复）。
- 状态回写：每次动作后更新 `instances`（状态、镜像 digest、端口、时间）。

数据表（草案）：`users`、`sessions`、`instances`、`tenant_keys`、`llm_usage`、`audit_log`。

接口抽象：`create/stop/start/delete(instance)`，一期调 Compose，二期调 K8s API。
