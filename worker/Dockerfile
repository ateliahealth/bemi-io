FROM node:24-bookworm AS base

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# pnpm >=10 refuses to reconcile node_modules without a TTY unless CI is set.
ENV CI=true
RUN npm install -g pnpm@10.32.1

WORKDIR /worker

COPY worker/package.json worker/pnpm-lock.yaml ./

################################################################################

FROM base AS deps

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

################################################################################

FROM base AS build

RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# tsconfig includes ../core/src, so core must sit beside the worker dir.
COPY core /core
RUN --mount=type=cache,id=pnpm,target=/pnpm/store cd /core && pnpm install --frozen-lockfile

COPY worker ./

RUN pnpm run build

################################################################################

FROM node:24-bookworm-slim

WORKDIR /worker

COPY --from=deps /worker/node_modules ./node_modules
COPY --from=build /worker/dist ./dist

USER node

CMD ["node", "dist/worker/src/index.js"]
