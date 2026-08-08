# Part of a fork of Bemi (https://github.com/BemiHQ/bemi-io),
# modified by Atelia Health, 2026. Licensed under SSPL-1.0; see LICENSE.
FROM node:24-bookworm AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# pnpm >=10 refuses to reconcile node_modules without a TTY unless CI is set.
ENV CI=true
RUN npm install -g pnpm@10.32.1

WORKDIR /repo

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY core/package.json core/package.json
COPY worker/package.json worker/package.json

################################################################################

FROM base AS deps

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

################################################################################

FROM base AS build

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# worker/tsconfig.json includes ../core/src, so core must stay a sibling of
# worker. That inclusion is what pushes tsc's inferred rootDir up a level and
# produces the doubled dist/worker/src + dist/core/src layout, which is
# referenced in three places outside the compiler: the Helm chart's container
# commands, the docker-compose service commands, and the entities/migrations
# paths in worker/mikro-orm.config.ts. Any tsconfig change that alters that
# inference silently relocates the output - the build still succeeds and the
# container then fails to start. Grep all three before changing tsconfig.
COPY core core
COPY worker worker

RUN pnpm --filter @bemi-db/worker run build

################################################################################

FROM node:24-bookworm-slim

WORKDIR /worker

COPY --from=deps /repo/node_modules ./node_modules
COPY --from=build /repo/worker/dist ./dist

USER node

CMD ["node", "dist/worker/src/index.js"]
