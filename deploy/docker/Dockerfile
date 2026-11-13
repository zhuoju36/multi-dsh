# syntax=docker/dockerfile:1.7
#
# multi-dsh user image: DeepSeek Harness + gateway + entrypoint.
#
# The DSH source is NOT vendored in this repository. Build with the DSH checkout
# as a named build context:
#
#   docker buildx build \
#     -f deploy/docker/Dockerfile \
#     --build-context dsh=/path/to/deepseek-harness \
#     -t multi-dsh/dsh:dev .
#
# Build context for this file is the multi-dsh repository root.

FROM node:24 AS dsh-build
WORKDIR /src
COPY --from=dsh . .
RUN corepack enable \
 && pnpm install --frozen-lockfile \
 && pnpm run build

FROM node:24-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git ripgrep curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -u 10001 -m dsh \
 && mkdir -p /data/dsh-home /data/projects /run/dsh /opt/multi-dsh \
 && chown -R dsh:dsh /data /run/dsh

# DSH runtime + built frontend (apps/web/dist), content packs, and deploy assets.
COPY --from=dsh-build /src /opt/multi-dsh/packages
COPY services/gateway /opt/multi-dsh/gateway
COPY deploy/docker/entrypoint.sh /opt/multi-dsh/docker/entrypoint.sh
COPY deploy/docker/template /opt/multi-dsh/template
COPY deploy/docker/patch /opt/multi-dsh/patch
RUN chmod +x /opt/multi-dsh/docker/entrypoint.sh

USER 10001
ENV DSH_HOME=/data/dsh-home \
    DSH_COMMAND="node /opt/multi-dsh/packages/apps/cli/lib/bin.js" \
    GATEWAY_ENTRY=/opt/multi-dsh/gateway/server.mjs \
    RUN_DIR=/run/dsh \
    LISTEN_PORT=8080 \
    DSH_WEB_PORT=3080
WORKDIR /data/projects
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.LISTEN_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/opt/multi-dsh/docker/entrypoint.sh"]
