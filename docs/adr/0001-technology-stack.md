# ADR-0001: ニュース要約アプリの技術スタック

日付: 2026-06-07
ステータス: Accepted

## 背景

ニュース要約アプリでは、以下を実現する必要がある。

- 日本語 IT 記事を RSS/API から収集する
- URL 正規化、重複排除、本文抽出を行う
- Gemini で記事を要約する
- 縦スワイプ型 UI で記事を閲覧できる
- PC ではスクロールをスワイプ相当の操作として扱う
- バッチ処理は所有済みオンプレ Ubuntu サーバーで運用する

詳細な検討内容は `docs/technology-selection-proposal.md` に記録する。

## 決定

MVP の技術スタックは以下を採用する。

| 領域 | 採用技術 |
|---|---|
| 言語 | TypeScript |
| ランタイム | Node.js 24 LTS |
| パッケージ管理 | pnpm workspace |
| Web | Next.js App Router |
| UI | React 19、Tailwind CSS v4、shadcn/ui |
| DB | PostgreSQL |
| ORM | Drizzle ORM + Drizzle Kit |
| バッチ基盤 | オンプレ Ubuntu Server + Docker Compose + systemd timer |
| AI | `@google/genai` + Gemini API |
| 本文抽出 | `@mozilla/readability` + `jsdom` |
| RSS/XML | `fast-xml-parser` |
| バリデーション | Zod |
| テスト | Vitest、Playwright |
| 監視 | journald、Docker logs、Sentry |

Web ホスティングは Vercel を第一候補とする。Web も自前運用する場合は Ubuntu + Docker + Caddy を使う。

DB ホスティングは Supabase Postgres またはオンプレ PostgreSQL とする。運用負荷を下げる場合は Supabase、自前管理を優先する場合はオンプレ PostgreSQL を選ぶ。

## 理由

- Web とバッチを TypeScript で統一でき、型・DB スキーマ・ドメインロジックを共有しやすい
- Next.js App Router は Server Components、Route Handler、Streaming を使えるため記事フィード UI と相性が良い
- Tailwind CSS v4 と shadcn/ui により、縦スワイプ型 UI を短期間で実装しやすい
- PostgreSQL は既存 DB 設計のテーブル構造、重複排除、ランキング、全文検索の拡張に向いている
- Drizzle ORM は TypeScript schema と SQL migration を扱いやすく、バッチ処理でも軽量に使える
- バッチ処理は本文抽出と LLM 呼び出しを含むため、Edge Runtime ではなく Ubuntu 上の Node.js コンテナで動かすほうが制約が少ない
- systemd timer はオンプレ Ubuntu で定期実行、ログ確認、起動状態確認がしやすい

## 影響

- `apps/web`、`apps/collector`、`packages/db`、`packages/domain` を持つ pnpm workspace 構成を前提にする
- バッチのデプロイ・実行・ログ確認は Ubuntu サーバーの Docker Compose と systemd に寄せる
- バッチは idempotent に実装し、`crawl_jobs` と記事単位 status で失敗を追跡する
- キューは MVP では DB job table とし、必要になったら pg-boss または Redis/BullMQ を検討する
- Gemini の model id、API key、DB 接続文字列は環境変数で管理する

## 代替案

- Cloud Run Jobs + Cloud Scheduler: バッチをオンプレ Ubuntu に置く方針のため不採用
- Pub/Sub: オンプレ前提ではまず DB job table を使い、必要時に pg-boss または Redis/BullMQ を検討する
- Prisma: 開発体験は良いが、DB 中心設計とバッチ利用では Drizzle の軽さと SQL への近さを優先する
- Python メインバッチ: 解析ライブラリは強いが、Web と DB schema の型共有を優先して TypeScript に統一する
- Kubernetes: MVP には運用負荷が過剰

## 追記

- 2026-06-07: 初版作成。技術選定提案書の内容と、オンプレ Ubuntu バッチ基盤の方針を Accepted として記録。
- 2026-06-07: 開発ハーネス、linter/formatter、自己フィードバック hook の詳細は ADR-0002 に分離して Accepted とした。
- 2026-06-20: バッチ基盤のうち、Docker Compose + systemd timer によるデプロイ・スケジュール・実行・ログ管理の決定は Superseded by ADR-0004。バッチは引き続きオンプレで運用し、Coolify とセルフホスト版 Trigger.dev で管理する。
