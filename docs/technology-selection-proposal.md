# ニュース要約アプリ 技術選定提案書

> 2026-06-20 追記: この文書のバッチ基盤に関する Docker Compose + systemd timer の記述は初期提案であり、現行決定ではない。現在のデプロイ・実行管理は [ADR-0004](adr/0004-batch-deployment-with-trigger-dev.md) に従い、オンプレの Coolify とセルフホスト版 Trigger.dev を使用する。

作成日: 2026-06-07  
対象: Web アプリケーション、ニュース収集・本文抽出・要約バッチ

## 結論

MVP は **TypeScript モノレポ + Next.js App Router + PostgreSQL + Drizzle ORM + オンプレ Ubuntu Server + Docker Compose + systemd timer + Gemini API** を推奨する。

理由は以下。

- Web とバッチで型・DB スキーマ・ドメインロジックを共有できる
- 設計書の縦スワイプ UI は Next.js/React/Tailwind で素直に実装できる
- RSS/API 取得、本文抽出、LLM 要約は Ubuntu 上の Node.js コンテナで動かすと制約が少ない
- バッチは所有済みオンプレ Ubuntu サーバーで運用し、systemd timer で定期起動、Docker Compose で再現性を担保する
- PostgreSQL は既存 DB 設計と相性が良く、トレンドスコア・重複排除・全文検索・後日の分析にも対応しやすい

## 推奨技術スタック

| 領域 | 採用候補 | 用途 |
|---|---|---|
| 言語 | TypeScript | Web、バッチ、DB スキーマ、共通型を統一 |
| ランタイム | Node.js 24 LTS | 2026 年時点の LTS。Web/バッチ双方で利用 |
| パッケージ管理 | pnpm workspace | モノレポ管理、依存の重複削減 |
| Web フレームワーク | Next.js App Router | 記事フィード、SSR/RSC、Route Handler |
| Web ホスティング | Vercel | Next.js の配信、Preview Deployment、Edge/CDN。Web も自前運用する場合は Ubuntu + Docker + Caddy |
| UI | React 19、Tailwind CSS v4、shadcn/ui | 縦スワイプ UI、カード UI、PC/モバイル対応 |
| アニメーション | Motion | カード遷移、スクロール補助アニメーション |
| 状態管理 | Zustand | 現在カード、入力デバイス状態など軽量な UI 状態 |
| データ取得 | Server Components + 必要時 TanStack Query | 初期表示はサーバー、クライアント側の追加取得は Query |
| DB | PostgreSQL | 記事、本文、要約、メトリクス、ジョブ履歴 |
| DB ホスティング | Supabase Postgres または Ubuntu 上の PostgreSQL | 運用負荷を下げるなら Supabase、データも自前管理するならオンプレ PostgreSQL |
| ORM | Drizzle ORM + Drizzle Kit | TypeScript schema、SQL migration、軽量な型安全クエリ |
| バッチ基盤 | Ubuntu Server + Docker Compose + systemd timer | RSS/API 取得、本文抽出、Gemini 要約、DB 保存 |
| キュー | MVP は DB job table、拡張時 Redis/BullMQ または pg-boss | 小規模は DB 管理、失敗隔離や並列化が必要になったら専用 worker |
| AI | `@google/genai` + Gemini API | 設計書どおり Flash-Lite/Flash で要約 |
| 本文抽出 | `@mozilla/readability` + `jsdom` | HTML から本文抽出。失敗時は RSS 概要または Gemini URL Context |
| RSS/XML | `fast-xml-parser` | RSS/Atom の正規化パーサ |
| URL 正規化 | `normalize-url`、`tldts` | 重複排除、canonical host/path 判定 |
| バリデーション | Zod | API、バッチ入力、Gemini 出力 JSON の検証 |
| Linter | oxlint | TypeScript/React/Next.js の高速 lint。ESLint は採用しない |
| Formatter | oxfmt | TypeScript/JavaScript/CSS/JSON の高速 format。Prettier は採用しない |
| テスト | Vitest、Playwright | ロジック単体テスト、縦スクロール UI の E2E |
| 監視 | journald、Docker logs、Sentry、必要時 Prometheus/Grafana | バッチ失敗、Web エラー、LLM エラーの可視化 |
| CI/CD | GitHub Actions + SSH deploy または GHCR pull | lint/test、Vercel deploy、Ubuntu サーバーへの compose 更新 |

## アーキテクチャ案

```txt
apps/web
  Next.js App Router
  Server Components / Route Handlers
  縦スワイプ型の記事 UI

apps/collector
  Ubuntu Server 上で systemd timer から定期実行
  Docker Compose の one-shot container として起動
  RSS/API 取得
  URL 正規化
  本文抽出
  Gemini 要約
  スコア計算
  DB 保存

packages/db
  Drizzle schema
  migrations
  DB client

packages/domain
  Article / Source / Summary 型
  スコアリング
  URL 正規化
  Gemini 出力 schema
```

## 開発ハーネス方針

2026-06-07 時点の実装準備では、ESLint/Prettier ではなく **oxlint 1.68.0** と **oxfmt 0.53.0** を採用する。どちらも Oxc compiler stack 上のツールで、TypeScript/React/Next.js を含む monorepo の高速な自己フィードバックに向いている。

root scripts は以下を標準にする。

```bash
pnpm format
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm verify
```

`pnpm verify` は `format:check -> lint -> typecheck -> test` の順に実行する。Codex lifecycle hook の `Stop` でも worktree 変更に応じて同じ自己フィードバックを起動し、AI エージェントが作業直後に機械的な失敗を検出できるようにする。

oxfmt は既存 ADR の append-only 方針と衝突しないよう、既存 `docs/**` と `AGENTS.md` は root script の整形対象から外す。コード、設定、ハーネス、package metadata は oxfmt の対象にする。

2026-06-07 時点で作成済みの開発足場:

- `apps/web`: Next.js 16 App Router、React 19、Tailwind CSS v4 の縦スクロール記事 UI
- `apps/collector`: dry-run 可能な TypeScript collector entrypoint
- `packages/domain`: Zod schema、URL 正規化、トレンドスコア、Vitest
- `packages/db`: Drizzle PostgreSQL schema、client、drizzle-kit config
- `docker-compose.yml`: local PostgreSQL と collector batch profile
- `deploy/systemd`: Ubuntu server 用 `news-collector.service` / `news-collector.timer`

## Web アプリ選定

### Next.js App Router

採用する。記事一覧は DB から読み取るサーバー主体の画面であり、Next.js の App Router、Server Components、Streaming と相性が良い。クライアント JS は縦スワイプ・キーボード操作・ホイール制御に絞る。

実装方針:

- 初期の記事リストは Server Component で取得
- スクロール・キーボード・カード遷移は Client Component に分離
- 追加読み込みは Route Handler 経由で cursor pagination
- PC は `scroll-snap-type: y mandatory` を基本に、wheel/trackpad の閾値制御を追加
- モバイルは pointer/touch と native scroll-snap を優先

### Tailwind CSS v4 + shadcn/ui

採用する。カード UI、レスポンシブ、ダークモード、コンポーネントの立ち上げが速い。Tailwind v4 は CSS-first の設定と高速なビルドが特徴で、MVP の UI 実装速度を上げられる。

注意点:

- shadcn/ui は「デザインシステムの素材」として使い、過剰なカード入れ子や装飾は避ける
- 縦スワイプ UI はライブラリ依存にしすぎず、CSS Scroll Snap + 自前の入力制御を中核にする

### TanStack Query

補助採用。初期表示は Next.js のサーバー取得で十分だが、クライアント側で「次ページの先読み」「トレンド順の再取得」「既読状態の反映」を入れる段階で使う。

## DB 選定

### PostgreSQL

採用する。設計書の `sources`、`feed_endpoints`、`crawl_jobs`、`articles`、`article_contents`、`article_summaries`、`article_metrics` はリレーショナル DB に素直に載る。URL 重複排除、source 別ランキング、日次スコア集計、全文検索を後から拡張しやすい。

推奨インデックス:

- `articles.normalized_url` unique
- `articles.published_at`
- `articles.source_id`
- `article_metrics.score`
- `article_summaries.article_id`
- `crawl_jobs.status, crawl_jobs.started_at`

### Supabase Postgres

Web を Vercel、バッチをオンプレ Ubuntu に置く構成なら、MVP の DB ホスティングとして推奨する。Postgres 管理、ダッシュボード、拡張、将来の Auth/Storage をまとめられる。認証機能が不要な初期段階でも、DB と管理 UI だけで十分価値がある。

注意点:

- Ubuntu サーバーから Supabase へ外向き接続できることを前提にする
- batch の DB 接続は pooled connection を使う
- 長時間バッチでコネクションを張りっぱなしにせず、処理単位で適切に解放する
- DB も完全に自前管理したい場合は、次のオンプレ PostgreSQL 案に切り替える

### オンプレ PostgreSQL

DB も所有 Ubuntu サーバーに置きたい場合の選択肢。外部 DB コストを抑えられ、バッチとの通信もローカルに閉じられる。ただし、バックアップ、アップグレード、ディスク監視、障害復旧は自分で持つ必要がある。

推奨方針:

- MVP は Docker Compose の `postgres` service + named volume で開始
- 本番データが重要になったら、PostgreSQL はホスト OS の package または専用 VM/サーバーに分離する
- 毎日 `pg_dump`、週次 full backup、世代管理、復元テストを行う
- Web が Vercel の場合は DB を直接インターネット公開せず、必要に応じて VPN / Tailscale / SSH tunnel / API 経由にする

代替:

- Neon: DB ブランチングや serverless Postgres を重視する場合に有力
- Cloud SQL: GCP に寄せて堅牢運用したい場合。ただし MVP では運用負荷が増える

### Drizzle ORM

採用する。既存設計が DB テーブル中心なので、TypeScript で schema を定義しつつ SQL に近い形で扱える Drizzle が合う。Prisma より軽量で、バッチ処理からも使いやすい。

運用方針:

- `packages/db/schema.ts` を schema の source of truth にする
- migration は `drizzle-kit generate` と `drizzle-kit migrate`
- Web と collector は同じ `packages/db` を参照する
- 複雑なランキング SQL は Drizzle の `sql` helper または view/materialized view を使う

## バッチ選定

### Ubuntu Server + Docker Compose + systemd timer

採用する。収集バッチは RSS/API 取得、外部 HTTP、HTML 解析、LLM 呼び出し、DB 書き込みを含むため、Ubuntu 上の Node.js コンテナで動かすのが扱いやすい。Docker Compose で実行環境を固定し、systemd timer で定期起動する。

`cron` でも実行はできるが、MVP では systemd timer を推奨する。理由は、`systemctl list-timers` で次回実行を確認でき、`journalctl -u` でログを追いやすく、`Persistent=true` により停止中に逃した定期実行の扱いも制御できるため。

MVP フロー:

```txt
systemd timer
  ↓
systemd service
  ↓
docker compose run --rm collector
  ↓
feed_endpoints を取得
  ↓
RSS/API fetch
  ↓
URL 正規化・重複排除
  ↓
本文抽出
  ↓
Gemini 要約
  ↓
スコア計算
  ↓
PostgreSQL 保存
```

実装上の重要点:

- バッチは idempotent にする
- `crawl_jobs` に開始・終了・件数・エラーを記録する
- 記事単位で `fetch_status`、`summary_status`、`retry_count` を持つ
- 1 記事の失敗で全体を落とさない
- Gemini の rate limit を考慮して concurrency を制御する
- systemd service には `Restart=on-failure` を設定し、無限再試行ではなく DB 側の retry_count と合わせて制御する
- `.env` はサーバー上に配置し、Gemini API key と DB 接続文字列を Git 管理しない
- `docker compose logs collector` と `journalctl -u news-collector.service` の両方で追えるよう、標準出力に構造化ログを出す

推奨 unit 構成:

```txt
/etc/systemd/system/news-collector.service
/etc/systemd/system/news-collector.timer

news-collector.timer:
  OnCalendar=*:0/15
  Persistent=true

news-collector.service:
  Type=oneshot
  WorkingDirectory=/opt/news-summary
  ExecStart=/usr/bin/docker compose run --rm collector
```

### キューは Phase 2 で導入

MVP では DB job table で十分。収集対象が増え、失敗記事の再実行や並列要約が必要になった段階で、オンプレ Ubuntu 上に worker を追加する。

Phase 2 構成:

```txt
systemd timer
  ↓
collector one-shot container
  ↓
article_jobs table
  ↓
worker container
  ↓
failed_article_jobs table
```

まずは PostgreSQL の `article_jobs` テーブルで良い。専用キューが必要になった場合は、以下の順に検討する。

- pg-boss: PostgreSQL だけでジョブキューを完結させたい場合
- Redis + BullMQ: worker の並列化、遅延ジョブ、リトライ、管理 UI を強めたい場合
- RabbitMQ: 将来、複数システムと連携する必要が出た場合

### クラウドマネージドバッチを採用しない理由

今回、バッチの実行基盤は所有済みオンプレ Ubuntu サーバーに置く前提のため、Cloud Run Jobs、Cloud Scheduler、Pub/Sub、Vercel Cron、Supabase Edge Functions、Cloudflare Workers は主構成にしない。

ただし、Web 配信は引き続き Vercel を推奨する。Web までオンプレ化する場合は、同じ Ubuntu サーバーまたは別サーバーで `web` コンテナを常駐させ、Caddy を reverse proxy と HTTPS 終端に使う。

## AI / 要約選定

設計書どおり、通常記事は **Gemini 2.5 Flash-Lite**、重要記事は **Gemini 2.5 Flash** を基本にする。2026-06-07 時点の公式 Gemini API models でも両モデルは掲載されている。

推奨方針:

- model id はコードに直書きせず env で管理する
- 通常記事: `GEMINI_MODEL_DEFAULT=gemini-2.5-flash-lite`
- 重要記事: `GEMINI_MODEL_IMPORTANT=gemini-2.5-flash`
- 出力は JSON schema を指定し、Zod で検証して DB 保存する
- 本文抽出に失敗した記事は RSS 概要で短縮要約する
- それでも不足する記事だけ Gemini URL Context を使う

要約出力 schema 例:

```ts
type ArticleSummary = {
  titleJa: string;
  oneLineSummary: string;
  bullets: string[];
  category: "ai" | "frontend" | "backend" | "infra" | "security" | "mobile" | "other";
  importance: 1 | 2 | 3 | 4 | 5;
  tags: string[];
};
```

## データ収集選定

### Phase 1

- Zenn: RSS
- Qiita: RSS/API
- はてなブックマーク IT: RSS

### Phase 2

- Hacker News: Firebase API または Algolia API
- GitHub Blog: RSS

### Phase 3

- 企業テックブログ: RSS 一覧を `sources` / `feed_endpoints` で管理
- GitHub Releases: GitHub REST API / Octokit
- DEV Community: API / RSS

### 本文抽出

`@mozilla/readability` + `jsdom` を基本にする。RSS の description/content が十分な場合は本文 fetch を省略し、外部サイトへの負荷を下げる。

失敗時:

1. RSS 概要のみで表示・要約
2. 重要記事だけ Gemini URL Context
3. それでも失敗したら `article_contents.extraction_status=failed`

## モノレポ構成

```txt
.
├── apps
│   ├── web
│   └── collector
├── packages
│   ├── db
│   ├── domain
│   ├── config
│   └── eslint-config
├── docs
└── package.json
```

各 package の責務:

- `apps/web`: UI、Route Handler、ページ
- `apps/collector`: batch entrypoint、source adapter、Gemini 呼び出し
- `packages/db`: Drizzle schema、migration、DB client
- `packages/domain`: URL 正規化、score 計算、summary schema
- `packages/config`: env schema、共通設定

## MVP 実装順

1. pnpm workspace と TypeScript 設定
2. `packages/db` に Drizzle schema と migration
3. `apps/collector` で Phase 1 RSS 取得
4. URL 正規化・重複排除・DB 保存
5. 本文抽出と fallback
6. Gemini 要約と JSON 検証
7. スコア計算
8. `apps/web` で縦スワイプ UI
9. Ubuntu サーバーに Docker Engine / Docker Compose plugin をセットアップ
10. `compose.production.yaml` と systemd service/timer を配置
11. GitHub Actions から SSH deploy または GHCR image pull で更新
12. Playwright で PC wheel / keyboard / mobile scroll の E2E

## 採用しないもの

| 技術 | 判断 | 理由 |
|---|---|---|
| Rails / Laravel | 非採用 | Web とバッチを TypeScript で統一するメリットが大きい |
| Python メインバッチ | 今回は非採用 | 解析ライブラリは強いが、Web/DB schema と型共有しにくい |
| Prisma | 保留 | 開発体験は良いが、既存の DB 中心設計では Drizzle の軽さと SQL 近さを優先 |
| tRPC | 保留 | 初期は Next.js Server Components / Route Handler で十分 |
| Kubernetes | 非採用 | MVP には運用負荷が過剰 |
| Elasticsearch / OpenSearch | 非採用 | 初期検索は Postgres full-text / trigram で足りる可能性が高い |
| Redis Queue | 保留 | 初期は DB job table。並列 worker や遅延ジョブが必要になった段階で Redis/BullMQ を検討 |
| Cloud Run / Pub/Sub | 非採用 | 今回のバッチ実行基盤は所有済みオンプレ Ubuntu サーバーに置くため |

## リスクと対策

| リスク | 対策 |
|---|---|
| 外部サイトの HTML 変更で本文抽出が失敗する | RSS 概要 fallback、source 別 adapter、失敗率を記録 |
| Gemini コスト増 | Flash-Lite を基本、重要記事のみ Flash、記事長に応じてチャンク制御 |
| LLM 出力の形式崩れ | structured output + Zod 検証 + retry |
| 同一記事の重複保存 | normalized URL unique、canonical URL、title/source/published_at の補助重複判定 |
| バッチの途中失敗 | article 単位 status、retry_count、crawl_jobs 監査ログ |
| PC のトラックパッド慣性でカードが飛ぶ | wheel delta の蓄積閾値、cooldown、scroll snap の併用 |
| 初期からキューを入れすぎて複雑化 | MVP は DB job table、処理量が増えたら pg-boss または Redis/BullMQ |
| オンプレ Ubuntu サーバー障害 | DB backup、compose file と systemd unit の Git 管理、復旧手順の文書化 |
| ディスク枯渇 | Docker log rotation、PostgreSQL backup 世代管理、本文保存量の上限設定 |
| OS/コンテナ更新漏れ | unattended-upgrades、定期的な Docker image rebuild、依存ライブラリの Dependabot |

## 参照した公式・一次情報

- Next.js App Router Docs: https://nextjs.org/docs/app
- React 19 Release: https://react.dev/blog/2024/12/05/react-19
- Tailwind CSS v4.0: https://tailwindcss.com/blog/tailwindcss-v4
- Drizzle ORM Migrations: https://orm.drizzle.team/docs/migrations
- Google Gen AI JavaScript SDK: https://googleapis.github.io/js-genai/
- Gemini API Models: https://ai.google.dev/gemini-api/docs/models
- Docker Compose Docs: https://docs.docker.com/compose/
- Docker Compose Production Guide: https://docs.docker.com/compose/how-tos/production/
- Docker Compose Linux Install: https://docs.docker.com/compose/install/linux/
- PostgreSQL Docker Guide: https://docs.docker.com/guides/postgresql/
- PostgreSQL Documentation: https://www.postgresql.org/docs/
- systemd.timer man page: https://www.freedesktop.org/software/systemd/man/latest/systemd.timer.html
- Caddy Automatic HTTPS: https://caddyserver.com/docs/automatic-https
- Caddy reverse_proxy: https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- Node.js Releases: https://nodejs.org/en/about/previous-releases
- TanStack Query Advanced SSR: https://tanstack.com/query/latest/docs/framework/react/guides/advanced-ssr
- Mozilla Readability: https://github.com/mozilla/readability
