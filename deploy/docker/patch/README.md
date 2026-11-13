# Placeholder for the deployment-level cordis patch (deploy.yml).

# entrypoint 只在 patch 文件非空时才传 `--patch`（空 patch 会让 dsh 启动失败）。
# 该文件会以 argv 层应用，优先级高于用户自己的 cordis.patch.yml。
# 示例（取消注释前请确认条目 id 存在）：
#
# - id: webserver
#   config:
#     compression: gzip
