# バッチ手動検証手順

作成日: 2026-06-07

この手順は collector batch がRSS/API取得、本文抽出、Gemini要約、PostgreSQL保存まで正常に動くことを手動確認するためのものです。

## 前提

- Node.js 24 LTS
- pnpm 10.8.1 以上
- Docker Compose
- `.env` が作成済み
- `DATABASE_URL` と `GEMINI_API_KEY` が `.env` に設定済み

`.env` はGit管理しません。APIキー、DB URL、トークン類をログやチャットへ貼らないでください。

## 1. 依存関係を準備する

```bash
pnpm install
```

## 2. PostgreSQLを起動する

```bash
docker compose up -d postgres
docker compose ps
```

期待結果:

- `postgres` service が `running` または `healthy` になる
- `localhost:5432` が公開される

Docker image のpullが止まる場合は、ネットワーク状態を確認してから再実行してください。

## 3. DB migrationを適用する

```bash
pnpm db:migrate
```

期待結果:

- Drizzle migration が成功する
- `sources`、`articles`、`article_summaries`、`article_metrics`、`crawl_jobs` などのテーブルが作成される

## 4. dry runで設定を確認する

```bash
pnpm dev:collector
```

期待結果:

- `dryRun: true` のログが出る
- ネットワーク取得、Gemini呼び出し、DB書き込みは行われない
- エラーなく起動できる

停止は `Ctrl+C` です。

## 5. DEBUG モードでロールバックと外部通信スキップを確認する

`DEBUG=true` は `COLLECTOR_DRY_RUN` より優先される。DB の開始・完了処理はトランザクションで実行されるが、完了時に必ずロールバックされる。RSS、記事本文、Gemini を含む外部通信は行わないため、`GEMINI_API_KEY` は不要である。

```bash
set -a
source .env
set +a
DEBUG=true pnpm --filter @upto/collector exec tsx src/index.ts
```

期待結果:

- `debug: true` と `debug_external_requests_skipped` のログが出る
- RSS/記事サイト/Gemini への通信は発生しない
- 実行前後で `sources`、`feed_endpoints`、`crawl_jobs`、`articles` の行数が増えない

## 6. 実取得を小さく実行する

まず1 feed あたり1件、並列数1で実行します。

```bash
set -a
source .env
set +a
COLLECTOR_DRY_RUN=false COLLECTOR_MAX_ITEMS_PER_FEED=1 COLLECTOR_CONCURRENCY=1 pnpm --filter @upto/collector exec tsx src/index.ts
```

期待結果:

- 各feedの `started` / `finished` ログが出る
- 成功した記事が `articleCount` に含まれる
- 単一記事の失敗があっても、他の記事やfeed処理は継続する
- Gemini APIキーが正しければ `article_summaries` に要約が保存される

## 7. DB保存結果を確認する

```bash
docker compose exec postgres psql -U upto -d upto
```

psql内で以下を実行します。

```sql
select status, count(*) from crawl_jobs group by status order by status;

select
  a.title,
  s.name as source_name,
  a.fetch_status,
  a.summary_status,
  m.score,
  a.published_at
from articles a
join sources s on s.id = a.source_id
left join article_metrics m on m.article_id = a.id
order by a.created_at desc
limit 10;

select
  a.title,
  sm.short_summary,
  jsonb_array_length(sm.bullets) as bullet_count,
  sm.model_id,
  sm.summarized_at
from article_summaries sm
join articles a on a.id = sm.article_id
order by sm.summarized_at desc
limit 10;
```

期待結果:

- `crawl_jobs` に直近の実行結果が記録される
- 成功記事は `fetch_status = fetched`、`summary_status = summarized` になる
- `short_summary` と `bullets` が保存される
- `score` が保存される

psql終了:

```sql
\q
```

## 8. idempotencyを確認する

同じ条件でもう一度実行します。

```bash
set -a
source .env
set +a
COLLECTOR_DRY_RUN=false COLLECTOR_MAX_ITEMS_PER_FEED=1 COLLECTOR_CONCURRENCY=1 pnpm --filter @upto/collector exec tsx src/index.ts
```

期待結果:

- 同じ `normalized_url` の記事で重複行が増えない
- 既存記事は更新される
- `crawl_jobs` は実行ごとに追加される

確認SQL:

```bash
docker compose exec postgres psql -U upto -d upto -c "select normalized_url, count(*) from articles group by normalized_url having count(*) > 1;"
```

期待結果:

- 結果が0件

## 9. 標準検証を実行する

```bash
pnpm verify
```

期待結果:

- format、lint、typecheck、unit test がすべて成功する

## 10. 後片付け

PostgreSQLを残す場合:

```bash
docker compose stop postgres
```

データも削除する場合:

```bash
docker compose down -v
```

`down -v` はローカルDBデータを削除します。本番や共有DBでは実行しないでください。

## 失敗時の確認ポイント

- `DATABASE_URL` が `.env.example` と同じキー名で設定されているか
- `COLLECTOR_DRY_RUN=false` が正しく渡っているか
- `GEMINI_API_KEY` が有効か
- Gemini model名が環境変数で不正な値になっていないか
- Docker PostgreSQLが起動済みか
- migrationを適用済みか
- feed元サイトへのネットワーク接続が可能か
