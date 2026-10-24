# Match @playwright/test in package.json. Always run as linux/amd64, including on Apple Silicon.
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:47b510dd9230bf0b9bfc9b20102241e577ea7a99334ab4c3ca19f19770e9b8ea
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
ENV UPTO_WEB_USE_FIXTURE_DATA=true
ENV DATABASE_URL=""
RUN npm install --global pnpm@10.8.1

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN pnpm install --frozen-lockfile --filter @upto/web...

COPY tsconfig.base.json ./
COPY packages/db/src packages/db/src
COPY packages/domain/src packages/domain/src
COPY apps/web/src apps/web/src
COPY apps/web/tsconfig.json apps/web/next.config.mjs apps/web/postcss.config.mjs apps/web/
RUN pnpm --filter @upto/web build

COPY playwright.visual.config.ts ./
COPY apps/web/e2e/visual/*.visual.spec.ts apps/web/e2e/visual/
ENTRYPOINT ["pnpm", "exec", "playwright", "test", "--config", "playwright.visual.config.ts"]
