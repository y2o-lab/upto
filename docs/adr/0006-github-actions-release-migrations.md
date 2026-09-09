# ADR-0006: GitHub Actions による production migration と Web デプロイの順序保証

日付: 2026-09-10
ステータス: Accepted

## 背景

Web の production branch は `release` であり、従来は Vercel の Git 連携が merge 後に deployment を開始していた。一方、DB schema を変更する release では、アプリケーションが新しい schema を前提に動き始める前に migration を完了させる必要がある。

Vercel の Git deployment と GitHub Actions は独立して実行されるため、Actions に migration job だけを追加しても、Vercel deployment より先に migration が終わる保証はない。

## 決定

`release` branch の Vercel Git 自動 deployment を `apps/web/vercel.json` で停止する。`release` への push を起点とする GitHub Actions workflow を Web production deployment の唯一の経路とし、次の順に実行する。

1. `production-release` GitHub Environment のSecretsから`DIRECT_DATABASE_URL`を注入し、`pnpm --filter @upto/db db:migrate` を実行する。
2. migration が成功した場合だけ、同じ workflow run で Vercel CLI の `deploy --prod` を実行する。

workflow は、先に `pnpm verify` を実行し、その成功後にmigrationへ進む。`production-release` concurrency group により直列化し、migration はアプリケーションや Trigger.dev task の起動時には実行しない。

## 理由

- migration 成功を production deployment の必須先行条件にできる。
- Vercel の自動 deployment との競合をなくし、同一 commit に対する実行順を明確にできる。
- Direct connection を migration 専用に保ち、Web runtime の pooler URL を migration に流用しない。
- GitHub Environment の secret store を利用し、production DB credential と Vercel token を workflow log やリポジトリへ残さない。

## 影響

- GitHub に `production-release` Environment を作成する。単独開発ではrequired reviewersを設定せず、release merge後に自動実行する。
- 同 Environment に `DIRECT_DATABASE_URL`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID`、`VERCEL_TOKEN` を secret として設定する。
- `release` push 時の production deployment は GitHub Actions の `Release web` workflow で確認する。
- migration の失敗時は Vercel deployment を開始しない。migration rollback は自動化しない。
- Trigger.dev task の deployment 方針は ADR-0005 のままであり、この workflow は Web production deployment だけを扱う。

## 代替案

- Vercel Git deployment を維持し、並行して migration workflow を実行する: 実行順が保証できないため不採用。
- アプリケーションまたは Trigger.dev task の起動時に migration を実行する: 複数 instance/run による競合と失敗時の切り分けが難しいため不採用。
- migration を手動運用のままにする: schema を使う deployment より先に実施されたことを機械的に保証できないため不採用。

## 追記

- 2026-09-10: 初版作成。Web production deployment の前に migration を成功させる経路を Accepted とした。
