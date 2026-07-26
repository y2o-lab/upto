# サーバーデプロイ手順書

作成日: 2026-06-08

この手順書は、Ubuntu Server 上で Upto の PostgreSQL と collector batch を運用し、必要に応じて Web を同じサーバーまたは Vercel で公開するための手順をまとめる。

現時点のリポジトリには `postgres` と `collector` の Docker Compose service がある。Web 用の Dockerfile / Compose service はまだないため、Web を同一サーバーで動かす場合は Node.js + systemd で起動する。

## 対象構成

- OS: Ubuntu Server
- Runtime: Node.js 24 LTS
- Package manager: pnpm 10.8.1 以上
- Database: PostgreSQL 17
- Batch: Docker Compose + systemd timer
- Web: Vercel、または Ubuntu Server 上の Node.js + systemd

## 前提

サーバーに以下を用意する。

- `git`
- Docker Engine
- Docker Compose plugin
- Node.js 24 LTS
- pnpm

例:

```bash
node --version
pnpm --version
docker --version
docker compose version
```

## ディレクトリ配置

例として `/opt/upto` に配置する。

```bash
sudo mkdir -p /opt/upto
sudo chown "$USER":"$USER" /opt/upto
git clone git@github.com:Inoue416/upto.git /opt/upto
cd /opt/upto
```

既存配置を更新する場合:

```bash
cd /opt/upto
git fetch origin
git switch codex-web-app
git pull --ff-only origin codex-web-app
```

本番運用ブランチが別に決まっている場合は、そのブランチ名に置き換える。

## 環境変数

`.env` はサーバー上にだけ作成し、Git にコミットしない。

Docker Compose 内の collector から Compose の `postgres` service に接続する場合、`DATABASE_URL` のホスト名は `localhost` ではなく `postgres` にする。

```bash
cd /opt/upto
cp .env.example .env
chmod 600 .env
```

本番例:

```env
DATABASE_URL=postgres://upto:upto@postgres:5432/upto
GEMINI_API_KEY=replace-with-production-key
GEMINI_MODEL_DEFAULT=gemini-3.1-flash-lite
GEMINI_MODEL_IMPORTANT=gemini-3.0-flash
DEBUG=false
COLLECTOR_DRY_RUN=false
COLLECTOR_CONCURRENCY=1
COLLECTOR_MAX_ITEMS_PER_FEED=20
SUMMARY_CHUNK_CHARS=12000
```

### env一覧

| 変数 | 必須 | 用途 | 本番の目安 |
|---|---:|---|---|
| `DATABASE_URL` | 必須 | Web と collector が接続する PostgreSQL URL | Docker Compose 内は `postgres://upto:upto@postgres:5432/upto` |
| `GEMINI_API_KEY` | collector 本番実行時は必須 | Gemini API キー | Secret としてサーバー上の `.env` のみに保存 |
| `GEMINI_MODEL_DEFAULT` | 任意 | 通常記事の要約モデル | `gemini-3.1-flash-lite` |
| `GEMINI_MODEL_IMPORTANT` | 任意 | 重要記事向けモデル | `gemini-3.0-flash` |
| `DEBUG` | 任意 | `true` ならDB書き込みを必ずロールバックし、RSS・本文取得・LLMなどの外部通信を行わない | 通常は `false` |
| `COLLECTOR_DRY_RUN` | 必須 | `true` ならネットワーク/LLM/DB書き込みなし | 本番は `false` |
| `COLLECTOR_CONCURRENCY` | 任意 | 記事処理の並列数 | 無料枠重視なら `1` |
| `COLLECTOR_MAX_ITEMS_PER_FEED` | 任意 | 1 feed あたりの最大取得件数 | 初期運用は `20` 以下 |
| `SUMMARY_CHUNK_CHARS` | 任意 | 要約時の本文チャンク文字数 | `12000` |
| `UPTO_WEB_USE_FIXTURE_DATA` | 本番では不要 | Web のPlaywright/fixture検証用 | 本番では設定しない |

`GEMINI_MODEL_*` を変更する場合は、実行前に対象モデルが使用中の Gemini API で有効であることを確認する。

## PostgreSQL 起動

```bash
cd /opt/upto
docker compose up -d postgres
docker compose ps
```

期待結果:

- `upto-postgres-1` が `healthy` になる
- `postgres-data` volume が作成される

## DB migration

collector image には workspace が含まれるため、Compose 経由で migration を実行できる。

```bash
cd /opt/upto
docker compose --profile batch build collector
docker compose --profile batch run --rm collector pnpm --filter @upto/db db:migrate
```

期待結果:

- Drizzle migration が成功する
- `sources`、`articles`、`article_summaries`、`article_metrics`、`crawl_jobs` などが作成される

## Collector の手動実行

初回は件数を絞って実行する。

```bash
cd /opt/upto
docker compose --profile batch run --rm \
  -e COLLECTOR_MAX_ITEMS_PER_FEED=1 \
  -e COLLECTOR_CONCURRENCY=1 \
  collector
```

期待結果:

- feed ごとに `started` / `finished` の JSON ログが出る
- 成功記事は `articles.summary_status = summarized` になる
- 既に `summary_status = summarized` の同一 `normalized_url` は `article_skipped_duplicate` として Gemini を呼ばずにスキップされる

DB確認:

```bash
docker compose exec postgres psql -U upto -d upto -c "select status, count(*) from crawl_jobs group by status order by status;"
docker compose exec postgres psql -U upto -d upto -c "select title, summary_status, published_at from articles order by created_at desc limit 10;"
docker compose exec postgres psql -U upto -d upto -c "select normalized_url, count(*) from articles group by normalized_url having count(*) > 1;"
```

最後のSQLは0件であることを確認する。

## Collector の定期実行

systemd timer で Docker Compose の collector を定期実行する。

`/etc/systemd/system/upto-collector.service`:

```ini
[Unit]
Description=Upto collector batch
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
WorkingDirectory=/opt/upto
ExecStart=/usr/bin/docker compose --profile batch run --rm collector
```

`/etc/systemd/system/upto-collector.timer`:

```ini
[Unit]
Description=Run Upto collector batch periodically

[Timer]
OnBootSec=5min
OnUnitActiveSec=30min
Persistent=true

[Install]
WantedBy=timers.target
```

反映:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now upto-collector.timer
systemctl list-timers upto-collector.timer
```

手動起動:

```bash
sudo systemctl start upto-collector.service
```

ログ確認:

```bash
journalctl -u upto-collector.service -n 200 --no-pager
journalctl -u upto-collector.service -f
```

## Web を同一サーバーで起動する場合

現時点では Web 用 Docker service は未作成のため、Node.js + systemd で動かす。

サーバー上の Node プロセスから Compose の PostgreSQL に接続する場合、公開ポート経由で `localhost` を使う。

Web 用の環境変数例:

```env
DATABASE_URL=postgres://upto:upto@localhost:5432/upto
```

ビルド:

```bash
cd /opt/upto
pnpm install --frozen-lockfile
pnpm --filter @upto/web build
```

systemd service 例:

`/etc/systemd/system/upto-web.service`:

```ini
[Unit]
Description=Upto web app
After=network-online.target docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=/opt/upto
EnvironmentFile=/opt/upto/.env.web
Environment=NODE_ENV=production
ExecStart=/usr/bin/pnpm --filter @upto/web start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`.env.web`:

```env
DATABASE_URL=postgres://upto:upto@localhost:5432/upto
```

起動:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now upto-web.service
sudo systemctl status upto-web.service
```

ログ:

```bash
journalctl -u upto-web.service -n 200 --no-pager
```

外部公開する場合は Caddy や nginx で `localhost:3000` へ reverse proxy する。

### Web エラー調査

初期表示や `/api/articles` が失敗した場合、画面と公開APIレスポンスには固定の短いエラーだけを出す。DB URL、stack trace、Next.js digest、内部例外 message はユーザー画面や公開APIレスポンスに出さない。

調査時は Web の標準出力と reverse proxy のログを確認する。

```bash
journalctl -u upto-web.service -n 200 --no-pager
journalctl -u upto-web.service -f
```

確認ポイント:

- `Failed to fetch article page`: `/api/articles` の内部エラー。`DATABASE_URL`、PostgreSQL の稼働状態、migration 状態を確認する。
- `Failed to render the article feed`: 初期表示の Server Component 取得または描画時の失敗。周辺ログに DB 接続や記事取得の例外がないか確認する。
- 400 の `invalid_cursor` / `invalid_snapshot`: client から渡された cursor または snapshotAt が不正。通常は再読み込みで復旧する。

## Web を Vercel で公開する場合

Vercel 側に少なくとも以下を設定する。

```env
DATABASE_URL=postgres://...
```

本番データを表示するため、`UPTO_WEB_USE_FIXTURE_DATA=true` は設定しない。

DB がオンプレサーバー上の PostgreSQL の場合、Vercel から接続できるネットワーク設計、TLS、IP制限、バックアップ方針を別途決める。運用負荷を下げる場合は Supabase Postgres などの外部PostgreSQLを使う。

## 更新デプロイ手順

```bash
cd /opt/upto
git fetch origin
git pull --ff-only
docker compose --profile batch build collector
docker compose --profile batch run --rm collector pnpm --filter @upto/db db:migrate
sudo systemctl restart upto-web.service
```

collector は timer の次回実行から新しい image を使う。即時実行したい場合:

```bash
sudo systemctl start upto-collector.service
```

## ロールバック

直前のコミットへ戻す例:

```bash
cd /opt/upto
git log --oneline -5
git switch --detach <rollback_commit>
docker compose --profile batch build collector
sudo systemctl restart upto-web.service
```

DB migration を戻す手順は現在用意していない。破壊的 migration を入れる場合は、事前にバックアップと復旧手順を作成する。

## バックアップ

PostgreSQL volume を消すとデータが失われる。定期的に dump を取得する。

```bash
mkdir -p /opt/upto/backups
docker compose exec -T postgres pg_dump -U upto -d upto > /opt/upto/backups/upto-$(date +%Y%m%d-%H%M%S).sql
```

復元は既存DBを上書きする可能性があるため、実行前に対象DBと dump 内容を確認する。

## トラブルシュート

- `DATABASE_URL is required`: `.env` または `.env.web` に `DATABASE_URL` がない。
- collector からDB接続できない: Docker Compose 内では `DATABASE_URL` のホスト名が `postgres` になっているか確認する。
- Web からDB接続できない: host 上の Web では `localhost:5432`、Compose 内の collector では `postgres:5432` を使い分ける。
- Gemini で失敗する: `GEMINI_API_KEY`、`GEMINI_MODEL_DEFAULT`、`GEMINI_MODEL_IMPORTANT` を確認する。
- 同じ記事が再要約される: `articles.normalized_url` に既存行があり、`summary_status = summarized` になっているか確認する。
- `docker compose down -v` は `postgres-data` volume を削除する。本番では実行しない。
