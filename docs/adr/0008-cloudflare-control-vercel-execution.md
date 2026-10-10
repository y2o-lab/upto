# ADR-0008: Cloudflareによるバッチ管理とVercelによる処理実行

日付: 2026-10-10
ステータス: Proposed

## 背景

現在はADR-0004/0005に従い、オンプレのセルフホスト版Trigger.devでcollectorを管理・実行する。オンプレ依存を減らして並列化し、無料枠を優先したい。Cloudflare無料WorkflowsはCPUが1 stepあたり10msのため、Node.jsでのRSS解析、jsdom/Readabilityによる本文抽出などをそのまま実行できるとは限らない。

ユーザー要件として、実際の処理実行はVercelへ置き、Cron、ステート、チャンク進捗、キューの管理はCloudflareに置く。またインフラリソースをTerraformで管理する。既存のWebはVercel、DNSはCloudflareを使用し、これらのTerraform構成とR2 remote stateが存在する。

## 決定案

- Cloudflare Cron、Workflows、Queues、SQLite-backed Durable Objectsで定期起動、処理順序、待機、再試行、並列数、Gemini送信許可を管理する。
- Cloudflare D1はjob/article work/chunk work/outboxなど制御状態の永続化に限定する。
- Vercel Node.js FunctionsでRSS/API取得・解析、本文抽出、チャンク生成、各チャンクの要約、統合、Zod検証、PostgreSQL保存を実行する。1 HTTP invocationは1段階または1チャンクに限定し、Cloudflareから認証して呼び出す。
- 本文、チャンクpayload、生成結果、最終記事は既存PostgreSQL/Drizzleへ保存する。Cloudflareは少量の参照IDと進捗を保持し、制御状態の正とする。DB接続はVercelから行い、このバッチにHyperdriveは導入しない。
- インフラリソースは既存Terraformを拡張して管理する。Worker bindings、Cron、Workflow定義、Queue/DLQ/consumer、DO class設定、D1、Vercel collector project、domain/DNSを対象にする。runtime instance、業務データ、schema migration、VercelのコードdeploymentはCI/runtime管理とする。
- staging/productionとTerraform stateを分離し、既存Webと外部管理のR2 state bucketを保持する。runtime secretの値はTerraform stateへ入れず、各サービスのsecret storeへ注入する。

具体的なフロー、API契約、Terraform管理対象、テストと切り戻しは[改訂移行計画](../cloudflare-batch-migration-plan.md)に記載する。

## 理由

- CPUを使う本文解析とSDK処理をNode.jsで動かし、Cloudflareを軽い制御処理へ限定できる。
- チャンクの実行状態、再開、投入待ちをCloudflareへ集約し、VercelのHTTP応答後の処理継続やメモリへ依存しない。
- 既存のcollector/domain/dbロジックを再利用し、本文抽出器の置き換えを移行の必須条件にしない。
- Terraformで構成と設定の変更をレビューし、リソースの手動作成や二重管理を避ける。

## 影響

- D1とPostgreSQL間の分散transactionはないため、operation ID、保存結果照会、定期照合で応答喪失・進捗確定漏れを回復する。
- Cloudflare/Vercel間の双方向認証、deadline、環境分離、再配送への冪等性が必要になる。
- Geminiの許可発行と実送信がサービスをまたぐため、許可期限と安全余裕を検証する。課金の完全な一回保証を仮定しない。
- 無料枠内での稼働はCPU、step数、Vercel使用量、D1/DO使用量の実測を条件とする。Vercel Hobbyの非商用個人利用条件、Functionの300秒制限が残る。
- 固定Terraform provider versionでresource schema、初回作成順序、DO migrations、secret保持、再apply時の差分をPoCで確認する。
- 本ADRは提案段階であり、ADR-0001/0004/0005の現行運用をまだ置き換えない。採用時に置き換える範囲を旧ADRへ追記し、Triggerの停止・新Cron有効化・切り戻しを実施する。

## 代替案

- Cloudflareですべて実行: 無料プランのCPU制限とNode互換性の検証が大きい。
- Cloudflare Containers: Nodeを維持しやすいが、有料プランとユーザー指定の実行場所に合わない。
- Vercel WorkflowsやInngestで実行管理: 実行環境として適合し得るが、管理をCloudflareへ集約する今回の要件に合わない。
- Trigger.dev Cloud / Cloud Run Jobs: 別案として有力だが、今回のCloudflare管理・Vercel実行の指定と異なる。

## 追記

- 2026-10-10: ユーザー指定の責務分担とTerraform管理をProposedとして記録。runtime/infraの変更は未実施。
