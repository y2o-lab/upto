# Gemini API RPM 制御・429 再試行 実装計画

作成日: 2026-08-18

## 背景

collector は記事処理を `COLLECTOR_CONCURRENCY`（既定値 `2`）件まで並列化している。一方、Gemini API 呼び出しには待機や RPM 制御がない。

さらに、本文が `SUMMARY_CHUNK_CHARS` を超える記事は、チャンクごとの要約と最終統合のために複数回 Gemini を呼び出す。重要記事モデルへの呼び出しに失敗した場合の通常モデルへのフォールバックも、追加の Gemini 呼び出しになる。このため、記事件数だけを数えて待機しても、実際の Gemini API の RPM を保証できない。

Trigger.dev task の queue concurrency は `1` だが、これはバッチ実行同士を直列化する設定であり、単一バッチ内の並列記事処理から発生する Gemini API リクエスト数は制限しない。

## 目的

- Gemini API のリクエスト開始数を、collector の1実行内で60秒あたり最大5件に制限する。
- `COLLECTOR_CONCURRENCY > 1` でも、すべての記事処理・チャンク要約・最終統合・モデルフォールバックが同じ上限を共有する。
- Gemini から HTTP 429 を受けた場合、待機して限定回数だけ再試行する。
- 既存の重複スキップ、記事単位の partial failure、Trigger.dev の task queue 設定、DB schema を変更しない。

## 非目標

- Gemini の TPM（tokens per minute）や1日あたりの利用上限を制御しない。
- 複数の同時 Trigger.dev worker や別プロセス間で共有する分散レートリミッターは導入しない。task queue の `concurrencyLimit: 1` により、通常運用では collector run は1件ずつであることを前提とする。
- 429 以外の Gemini エラー分類・再試行方針を全面的に変更しない。
- DB migration、記事 schema、API key の保存方法を変更しない。

## 方針

### リクエスト単位の共有レートリミッター

`createGeminiSummarizer()` ごとに、Gemini の `generateContent()` 呼び出しを通す共有レートリミッターを1つ作る。

- 単位は「記事」ではなく、Gemini へ送信を開始する1リクエストとする。
- 直近60秒間のリクエスト開始時刻を保持し、5件に達している場合は最も古い時刻が60秒を過ぎるまで待機する。
- 待機解除後はキュー先頭から順に1件ずつ開始可否を再判定する。
- そのため、同時に複数の記事処理が到達しても合計で60秒あたり5リクエストを超えない。
- 5件が短時間に開始された場合、6件目は約60秒待機する。先行リクエストが時間的に分散している場合は、固定の60秒 sleep を毎回入れず、空いた枠から開始する。

この制御は `p-limit` の記事処理並列数とは独立して共有する。待機中の処理は非同期で保留されるため、並列タスクのいずれも Gemini 呼び出しを制限外へ進められない。

### 429 の再試行

Gemini 呼び出しを単一の薄い関数に集約し、429 のときだけ再試行する。

- Gemini SDK が `Retry-After` を公開している場合はその値を優先する。
- 値を取得できない場合は、上限付き指数バックオフにランダムな揺らぎを加える。
- 再試行回数は設定可能にし、既定値は2回とする。初回を含め最大3回の API 呼び出しとなる。
- 再試行も必ず共有レートリミッターを通す。429 を受けた直後に制限外で再送しない。
- 429 以外のエラーと、再試行回数を使い切った429は現在どおり記事単位の失敗として記録し、残りの記事処理を続ける。

## 設定

以下を collector の非 secret 環境変数として追加する。

| 変数 | 既定値 | 用途 |
| --- | ---: | --- |
| `GEMINI_REQUESTS_PER_MINUTE` | `5` | collector 1実行あたりの Gemini リクエスト開始数の上限 |
| `GEMINI_RATE_LIMIT_MAX_RETRIES` | `2` | HTTP 429 に対する追加再試行回数 |

いずれも正の整数として Zod で検証する。`GEMINI_REQUESTS_PER_MINUTE` はモデルごとではなく、通常・重要モデルを合算した API key 単位の保守的な上限として扱う。

## 変更対象

| 対象 | 変更内容 |
| --- | --- |
| `apps/collector/src/gemini-rate-limiter.ts`（新規） | 60秒の移動窓、待機キュー、時刻・sleep を注入可能なレートリミッターを実装する。 |
| `apps/collector/src/gemini-rate-limiter.test.ts`（新規） | 5件開始後の待機、60秒経過後の解除、同時要求の共有上限を fake timer で検証する。 |
| `apps/collector/src/summarizer.ts` | すべての `generateContent()` を共通の送信関数へ集約し、レートリミットと429再試行を適用する。チャンク、最終統合、フォールバックすべてを対象にする。 |
| `apps/collector/src/summarizer.test.ts`（新規または追加） | 通常・長文・フォールバック・429再試行が共通の制御を通ること、非429が再試行されないことを検証する。 |
| `apps/collector/src/config.ts` | 新しい環境変数を collector 設定へ追加する。 |
| `apps/collector/src/config.test.ts` | 既定値、明示値、不正値の検証を追加する。 |
| `apps/collector/src/run-collector.ts` | `createGeminiSummarizer()` へ新設定を渡す。記事処理の `p-limit` とDB処理の責務は変更しない。 |
| `apps/collector/src/run-collector.test.ts` | `COLLECTOR_CONCURRENCY > 1` の記事処理で、要約器を共有していることと既存の partial failure を維持することを確認する。 |
| `apps/collector/src/.env.example` | 新しい非 secret 変数名と既定値を追記する。 |
| `docs/server-deployment-runbook.md` | Trigger.dev runtime の環境変数表、RPM監視、設定変更後の確認手順を追記する。 |
| `docs/manual-batch-verification.md` | staging で低い件数・並列数を使った実行と、待機ログ・Gemini 使用量を確認する手順を追記する。 |

## 実装手順

1. 先に `gemini-rate-limiter` の失敗するテストを追加する。並列に到着した要求を含め、6件目が60秒経過前に開始しないことを確認する。
2. 時刻と待機関数を注入できる、プロセス内共有用のレートリミッターを実装する。実時間でテストを待たないよう fake timer を使う。
3. `summarizer.ts` に Gemini 送信関数を追加し、`requestChunkSummary()` と `requestFinalSummary()` の双方が必ずこの関数を使うようにする。
4. Gemini SDK の429エラーから status と `Retry-After` を安全に抽出する。情報が得られない場合のバックオフ値を決め、待機と再試行もテストで固定可能にする。
5. 設定 schema、`runCollector()` の要約器生成、環境変数例を更新する。
6. collector の並列設定を `2` 以上にしたテストを追加し、並列記事・長文チャンク・フォールバックの合計が共有上限を守ることを確認する。
7. runbook と手動検証手順を更新し、Trigger.dev の runtime 環境変数を staging / production へ設定する手順を明記する。

## 受け入れ条件

- `GEMINI_REQUESTS_PER_MINUTE=5` のとき、同じ collector run 内の6件目の Gemini リクエストは、最初の5件のうち最も古い開始から60秒経つまで開始しない。
- `COLLECTOR_CONCURRENCY=2` 以上でも、並列記事の Gemini リクエスト合計が上限を超えない。
- 長文の各チャンク要約と最終統合も上限に数えられる。
- 重要モデルから通常モデルへのフォールバックも上限に数えられる。
- HTTP 429 の再試行は `Retry-After` またはバックオフ後に行われ、再試行自体も上限に数えられる。
- 非429エラーは不要に再試行されず、既存どおり当該記事のみ失敗として扱われる。
- 既存の要約済み記事の重複スキップ、DB保存、feed job 集計、Trigger.dev の run queue concurrency は変わらない。
- 実装・テスト中に API key、記事本文、Gemini 生レスポンスをログまたはfixtureへ追加しない。

## 検証計画

実装後、まず collector に限定して実行する。

```bash
pnpm --filter @upto/collector test
pnpm --filter @upto/collector typecheck
pnpm format:check
pnpm lint
```

続いて monorepo 全体の型・回帰を確認する。

```bash
pnpm typecheck
pnpm test
pnpm -r build
```

Trigger.dev 接続情報を設定できる deploy host では、追加で次を実行する。

```bash
pnpm trigger:deploy:dry-run
sh -n apps/collector/scripts/deploy-trigger.sh
```

staging では `COLLECTOR_DRY_RUN=false`、`COLLECTOR_CONCURRENCY=2`、`GEMINI_REQUESTS_PER_MINUTE=5`、少数の新規記事で手動実行する。Trigger.dev の時刻付きログと Gemini 使用量から、6件目が制限枠の解放前に送信されないこと、429発生時に残りの記事が継続することを確認する。

## リスクと注意点

- このレートリミッターは1つの collector process 内だけで有効である。将来 task queue concurrency を2以上へ変更する場合、API key 単位で上限を共有する外部ストア方式を別途設計する必要がある。
- API プラン・モデル別にRPMが異なる場合でも、設定値はもっとも低い対象モデルの上限以下に設定する。
- 待機中の記事処理は `p-limit` の並列枠を使用し続ける。これは Gemini 送信待ちを明示的なバックプレッシャーにし、本文抽出やDB書込みを無制限に先行させないための意図した挙動である。
- Gemini SDK のエラー形式はバージョン依存になり得るため、429判定は型に過度に依存せず、SDK更新時にテストで確認する。
- 現在の Trigger.dev task 最大実行時間は2時間であり、低いRPM設定と多数の長文記事の組み合わせでは所要時間が延びる。stagingで実測して、必要なら記事件数または並列数を調整する。
