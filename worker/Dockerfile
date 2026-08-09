# Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
# modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
FROM node:24-bookworm AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# pnpm >=10 refuses to reconcile node_modules without a TTY unless CI is set.
ENV CI=true
RUN corepack enable

WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json turbo.json ./
COPY core/package.json core/package.json
COPY worker/package.json worker/package.json

################################################################################

FROM base AS deps

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

################################################################################

FROM base AS build

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

COPY core core
COPY worker worker

RUN pnpm turbo run build --filter=@bemi-db/worker

################################################################################

FROM node:24-bookworm-slim

WORKDIR /worker

COPY --from=deps /repo/node_modules ./node_modules
COPY --from=build /repo/worker/dist ./dist
# core's published surface is dist plus its manifest, per its files field.
COPY --from=build /repo/core/dist ./node_modules/@bemi-db/core/dist
COPY --from=build /repo/core/package.json ./node_modules/@bemi-db/core/package.json

USER node

CMD ["node", "dist/src/index.js"]
