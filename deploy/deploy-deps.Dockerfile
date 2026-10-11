# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:24-bookworm
FROM ${NODE_IMAGE}
ARG BUILD_ROOT=/juno-build
WORKDIR ${BUILD_ROOT}
ENV CI=1
# Each lockfile owns a separate cached layer. Source and production secrets are
# introduced only in the ephemeral build container, after the offline gates.
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund --ignore-scripts && npx prisma generate
COPY runner/agent-core/package.json runner/agent-core/package-lock.json ./runner/agent-core/
RUN --mount=type=cache,target=/root/.npm npm ci --prefix runner/agent-core --no-audit --no-fund
COPY runner/env-server/package.json runner/env-server/package-lock.json ./runner/env-server/
RUN --mount=type=cache,target=/root/.npm npm ci --prefix runner/env-server --no-audit --no-fund
COPY relay/package.json relay/package-lock.json ./relay/
RUN --mount=type=cache,target=/root/.npm npm ci --prefix relay --no-audit --no-fund
LABEL com.alevr.deploy.dependencies=true
