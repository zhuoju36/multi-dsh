#
# multi-dsh user image: DeepSeek Harness + gateway + entrypoint.
#
# The DSH source is NOT vendored in this repository. Build with the DSH checkout
# as a named build context:
#
#   docker buildx build \
#     -f deploy/docker/Dockerfile \
#     --build-context dsh=/path/to/deepseek-harness \
#     --build-arg DSH_VERSION=$(node -p "require('/path/to/deepseek-harness/package.json').version") \
#     -t multi-dsh/dsh:dev .
#
# Build context for this file is the multi-dsh repository root.

ARG DSH_VERSION=unknown
ARG DSH_COMMIT=unknown

FROM node:24 AS dsh-build
ARG NPM_REGISTRY=https://registry.npmmirror.com
ENV COREPACK_NPM_REGISTRY=$NPM_REGISTRY \
    CI=true
WORKDIR /src
COPY --from=dsh . .
RUN corepack enable \
 && pnpm config set registry "$NPM_REGISTRY" \
 && pnpm install --frozen-lockfile \
 && pnpm run build

FROM node:24-slim AS runtime
ARG DSH_VERSION=unknown
ARG DSH_COMMIT=unknown
LABEL org.opencontainers.image.title="multi-dsh user image" \
      multi-dsh.dsh.version="${DSH_VERSION}" \
      multi-dsh.dsh.commit="${DSH_COMMIT}"

# deb.debian.org is unusable from mainland China; switch to the Aliyun mirror.
RUN (sed -i \
      -e 's|http://deb.debian.org/debian-security|http://mirrors.aliyun.com/debian-security|g' \
      -e 's|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g' \
      /etc/apt/sources.list.d/debian.sources 2>/dev/null || true) \
 && apt-get -o Acquire::Retries=5 update \
 && apt-get -o Acquire::Retries=5 install -y --no-install-recommends ca-certificates git ripgrep curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd -u 10001 -m dsh \
 && mkdir -p /data/dsh-home /data/projects /data/home /run/dsh /opt/multi-dsh \
 && chown -R dsh:dsh /data /run/dsh

# DSH runtime + built frontend (apps/web/dist).
COPY --from=dsh-build /src /opt/multi-dsh/packages
# Gateway (zero third-party dependencies) and the shared helpers it imports.
# The relative layout must match the repository layout: gateway imports
# ../../packages/shared/src/*.
COPY services/gateway /opt/multi-dsh/app/services/gateway
COPY packages/shared /opt/multi-dsh/app/packages/shared
COPY deploy/docker/entrypoint.sh /opt/multi-dsh/docker/entrypoint.sh
COPY deploy/docker/template /opt/multi-dsh/template
COPY deploy/docker/patch /opt/multi-dsh/patch
RUN chmod +x /opt/multi-dsh/docker/entrypoint.sh \
 && chmod -R a+rX /opt/multi-dsh/app /opt/multi-dsh/docker /opt/multi-dsh/template /opt/multi-dsh/patch

USER 10001
ENV DSH_HOME=/data/dsh-home \
    HOME=/data/home \
    TMPDIR=/tmp \
    XDG_CACHE_HOME=/tmp/cache \
    NPM_CONFIG_CACHE=/tmp/npm \
    PIP_CACHE_DIR=/tmp/pip \
    DSH_COMMAND="node /opt/multi-dsh/packages/apps/cli/lib/bin.js" \
    GATEWAY_ENTRY=/opt/multi-dsh/app/services/gateway/server.mjs \
    RUN_DIR=/run/dsh \
    LISTEN_PORT=8080 \
    DSH_WEB_PORT=3080
WORKDIR /data/projects
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.LISTEN_PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/opt/multi-dsh/docker/entrypoint.sh"]
