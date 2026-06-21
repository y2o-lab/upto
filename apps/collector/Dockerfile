FROM node:24-slim AS base
WORKDIR /app
RUN corepack enable

FROM base AS deps
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml ./
COPY apps/collector/package.json apps/collector/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm --filter @upto/domain build \
  && pnpm --filter @upto/db build \
  && pnpm --filter @upto/collector build

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN corepack enable
COPY --from=build /app ./
RUN sed -i 's#./src/index.ts#./dist/index.js#g' \
  packages/domain/package.json \
  packages/db/package.json
CMD ["pnpm", "--filter", "@upto/collector", "start"]
