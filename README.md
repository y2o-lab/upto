# Upto

Japanese IT news summary app.

## Requirements

- Node.js 24 LTS for normal development and CI
- pnpm 10.8.1 or newer
- Docker Compose when running local PostgreSQL

This repository currently also verifies on Node.js 22.14.0, but Node.js 24 is the project target.

## Setup

```bash
pnpm install
cp .env.example .env
```

Do not commit `.env`.

## Development

```bash
pnpm dev:web
pnpm dev:collector
```

The collector defaults to `COLLECTOR_DRY_RUN=true`, so it can be started without database or Gemini credentials.

For local PostgreSQL:

```bash
docker compose up -d postgres
pnpm db:migrate
```

## Supabase database connections

本番では実行環境ごとに接続URLを分ける。

- Vercel Webの`DATABASE_URL`: Supabase Transaction pooler（port 6543）
- Trigger.dev collectorの`DATABASE_URL`: IPv6を利用できる場合はDirect connection、IPv4のみの場合はSession pooler（port 5432）
- migration環境の`DIRECT_DATABASE_URL`: Supabase Direct connection（port 5432）
- `DATABASE_POOL_MAX`: 初期値は`2`。Webとcollectorの負荷、Supabaseの接続数を確認して環境ごとに調整する

remote DB接続ではTLSを自動的に有効化する。DB URLとpasswordはVercel、Trigger.dev、migration実行環境のsecretとして管理し、クライアントへ公開しない。

## Verification

The standard local gate is:

```bash
pnpm verify
```

It runs:

1. `pnpm format:check`
2. `pnpm lint`
3. `pnpm typecheck`
4. `pnpm test`

Use `pnpm format` to apply oxfmt. ESLint and Prettier are intentionally not used.

For browser coverage:

```bash
pnpm exec playwright install chromium
pnpm exec playwright test
```

## Codex Harness

Codex instructions, rules, hooks, skills, and subagents are checked into this repository.

- `AGENTS.md`
- `.codex/config.toml`
- `.codex/rules/project.rules`
- `.codex/hooks.json`
- `.codex/hooks/`
- `.agents/skills/`
- `.codex/agents/`

When project hooks change, open `/hooks` in Codex CLI and trust the updated definitions after review.
