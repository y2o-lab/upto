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

Set `DEBUG=true` to run only the collector's database lifecycle inside a transaction that is always rolled back. This mode requires `DATABASE_URL`, but skips RSS, article-content, Gemini, and other external requests.

For local PostgreSQL:

```bash
docker compose up -d postgres
pnpm db:migrate
```

## Supabase database connections

本番では実行環境ごとに接続URLを分ける。

設定、migration、疎通確認、rollbackの詳細は[Supabase接続デプロイ手順書](docs/supabase-deployment-runbook.md)を参照する。

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
pnpm test:e2e
```

### CIでの品質ゲート

PRの作成・更新時と`main`へのpush時には、`verify.yml`で次のチェックを並列実行する。

- `Unit and static checks`: 整形・Lint・型チェック・単体テスト（`pnpm verify`）
- `Web E2E / Playwright`: デスクトップ／モバイルChromiumのE2E全件（`pnpm test:e2e`）

最後に`verify`ジョブが両方の結果を集約し、一方でも失敗・キャンセル・スキップした場合は品質ゲートを失敗させる。
既存の`verify`チェックを必須にしている場合は、そのままE2Eもマージ条件に含まれる。

E2Eは`web-e2e.yml`に共通化し、固定データとローカルサーバーで実行する。DB・Gemini・デプロイ用のSecretsは不要。
失敗したテストはジョブを失敗させ、HTMLレポートと失敗時のスクリーンショット・トレースをActionsの`playwright-report`アーティファクトに7日間保存する。
`web-e2e.yml`はActions画面から手動実行もできる。

`release`へのpush時も同じE2Eを実行し、単体テストを含む`Verify release`と`Release Web E2E / Playwright`の両方が成功するまで本番マイグレーション・デプロイを開始しない。

PRのマージ自体を禁止するには、GitHubのブランチ保護／Rulesetで結果を集約する`verify`を必須ステータスチェックに指定する。
初回のActions実行後に表示されるチェック名を確認して設定する。Workflowファイルの追加だけではGitHub側の必須チェック設定は変更されない。

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
