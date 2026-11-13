# deploy/k8s

（二期）每用户实例与共享组件的清单模板。一期**不实现**，目录保持空骨架。

计划内容：

- `namespace/` — `multi-dsh-system`（router/auth/registry）与 `multi-dsh-tenants`（用户实例）。
- `instance/` — 每用户 Deployment/StatefulSet + PVC + NetworkPolicy + 只读 `/opt/multi-dsh` 卷；按 `USER_ID`、`USER_HOST` 参数化。
- `router/`、`auth/` — 无状态副本、Service、PDB。
- `networkpolicy/` — 默认拒绝；ingress 仅 router；egress 仅 DNS + 出口代理。
- `backup/` — restic CronJob。

二期同时引入：子域 + 通配证书、router 按 Host 路由、gateway 拆 sidecar。演练与迁移步骤记入 `docs/operations.md`。
