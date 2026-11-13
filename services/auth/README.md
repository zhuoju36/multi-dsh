# services/auth

自建账号体系与登录态签发。DSH 不感知账号——这里是"用户浏览器"与"该用户实例"之间唯一的身份来源。

一期范围：

- 用户名 + 密码注册/登录；密码 Argon2id 哈希；登录失败按 IP + 账号限流（5 次 / 5 分钟）。
- 服务端会话表（PG）：随机会话 ID、过期时间、可即时吊销；`Set-Cookie: mdsh_session=…; HttpOnly; SameSite=Lax; Path=/`。
- 一期无 TLS，cookie 不带 `Secure`；只在 `127.0.0.1` 使用，不暴露到内网/公网。
- `GET /login?next=…` 与 `POST /login`：`next` 必须是 registry 中的 `127.0.0.1:<port>`，防开放重定向。
- `POST /introspect`（仅供 gateway 内网调用）：cookie → `{user_id, instance, host_port, status}`。
- 审计：登录成功/失败、注销、密码修改。

后续（二期）：OIDC/SSO、MFA、邀请制开户、设备列表、密码重置流程。
