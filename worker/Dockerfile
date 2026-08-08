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

# The default isolated linker puts worker's deps behind symlinks into
# /repo/node_modules/.pnpm, which do not survive being copied to a different
# path. Hoisted gives a self-contained directory the final stage can relocate.
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
  pnpm install --prod --frozen-lockfile --filter @bemi-db/worker --config.node-linker=hoisted

################################################################################

FROM base AS build

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# worker/tsconfig.json includes ../core/src, so core must stay a sibling of
# worker; that is what pushes tsc's rootDir up and produces the dist/worker +
# dist/core layout the runtime commands and mikro-orm.config.ts expect.
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
