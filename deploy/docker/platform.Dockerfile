#
# One image for the platform services; SERVICE selects the entry point.
# Build context is the repository root (see deploy/compose/compose.platform.yml).
#
#   docker buildx build -f deploy/docker/platform.Dockerfile \
#     --build-arg SERVICE=auth -t multi-dsh/auth:dev .

ARG SERVICE=auth
FROM node:24-slim

ARG SERVICE
WORKDIR /app
ENV NODE_ENV=production \
    CI=true

# Workspace manifests first: corepack reads packageManager from package.json.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
ARG NPM_REGISTRY=https://registry.npmmirror.com
# Domestic npm mirror for both the corepack download and dependency installs.
ENV COREPACK_NPM_REGISTRY=$NPM_REGISTRY
RUN corepack enable && pnpm config set registry "$NPM_REGISTRY"

COPY packages ./packages
COPY services ./services
COPY db ./db
RUN pnpm install --frozen-lockfile --prod
RUN chmod -R a+rX /app

USER node
WORKDIR /app/services/${SERVICE}
CMD ["node", "src/server.mjs"]
