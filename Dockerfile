# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS base

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

RUN --mount=type=cache,id=supplier-apt-lists,target=/var/lib/apt/lists,sharing=locked \
    --mount=type=cache,id=supplier-apt-cache,target=/var/cache/apt,sharing=locked \
    apt-get update \
      -o Acquire::Retries=5 \
      -o Acquire::http::Timeout=30 \
      -o Acquire::https::Timeout=30 && \
    apt-get install -y --no-install-recommends ca-certificates openssl

RUN corepack enable && \
    corepack prepare pnpm@9.12.0 --activate

WORKDIR /workspace

FROM base AS dependencies

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json ./
COPY apps/bff/package.json apps/bff/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/crawler/package.json packages/crawler/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/entitlements/package.json packages/entitlements/package.json
COPY packages/llm-client/package.json packages/llm-client/package.json
COPY packages/platform-sdk/package.json packages/platform-sdk/package.json
COPY packages/scoring/package.json packages/scoring/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json

RUN --mount=type=cache,id=supplier-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile

FROM dependencies AS source

COPY . .

FROM source AS bff-builder

RUN DATABASE_URL=postgresql://build:build@127.0.0.1:5432/build \
    DIRECT_URL=postgresql://build:build@127.0.0.1:5432/build \
    pnpm exec turbo run build --filter=@supplier/bff

RUN pnpm --filter @supplier/bff deploy --prod /out/bff && \
    pnpm --dir /out/bff exec prisma generate \
      --schema node_modules/@supplier/db/prisma/schema.prisma

FROM source AS web-builder

ARG NEXT_PUBLIC_AUTH_MODE
ARG NEXT_PUBLIC_SIGNUP_ENABLED=false
ARG NEXT_PUBLIC_BFF_URL
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY

ENV NEXT_PUBLIC_AUTH_MODE=$NEXT_PUBLIC_AUTH_MODE
ENV NEXT_PUBLIC_SIGNUP_ENABLED=$NEXT_PUBLIC_SIGNUP_ENABLED
ENV NEXT_PUBLIC_BFF_URL=$NEXT_PUBLIC_BFF_URL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY

RUN test "$NEXT_PUBLIC_AUTH_MODE" = supabase && \
    { test "$NEXT_PUBLIC_SIGNUP_ENABLED" = true || test "$NEXT_PUBLIC_SIGNUP_ENABLED" = false; } && \
    test -n "$NEXT_PUBLIC_BFF_URL" && \
    test -n "$NEXT_PUBLIC_SUPABASE_URL" && \
    test -n "$NEXT_PUBLIC_SUPABASE_ANON_KEY"

RUN pnpm exec turbo run build --filter=@supplier/web

FROM base AS bff

ENV NODE_ENV=production
ENV NODE_OPTIONS=--enable-source-maps
ENV PORT=3001

WORKDIR /app

COPY --from=bff-builder --chown=node:node /out/bff ./

USER node

EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3001') + '/api/health/live').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "dist/main.js"]

FROM bff AS migrate

HEALTHCHECK NONE

ENTRYPOINT ["node", "node_modules/prisma/build/index.js"]
CMD ["migrate", "deploy", "--schema", "node_modules/@supplier/db/prisma/schema.prisma"]

FROM node:22-bookworm-slim AS web

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

WORKDIR /app

COPY --from=web-builder --chown=node:node /workspace/apps/web/.next/standalone ./
COPY --from=web-builder --chown=node:node /workspace/apps/web/.next/static ./apps/web/.next/static

USER node

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/').then((response) => { if (!response.ok) process.exit(1); }).catch(() => process.exit(1));"]

CMD ["node", "apps/web/server.js"]
