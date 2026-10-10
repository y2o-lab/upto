# Cloudflare管理・Vercel実行の移行実装計画を作るための引き継ぎ書

作成日: 2026-10-10
対象リポジトリ: Upto（日本語ITニュース要約アプリ）
現在の作業段階: 調査・構成案・図解まで。移行コード、インフラ作成、本番切替は未実施。
次の担当の成果物: 現行コードと本書を基に、実装順序、PR分割、API/DB/state設計、検証、デプロイ・切り戻しを具体化した移行実装計画。

## 1. 依頼と要件

ユーザーはオンプレのセルフホスト版Trigger.devから移行し、記事処理を並列化したい。検討の結果、以下の責務分担を指定した。

| 場所 | 必須の責務 |
| --- | --- |
| Cloudflare | Cron、ステート、記事・チャンク進捗、キュー、実行順序、待機・再試行、並列数、Gemini送信量の管理 |
| Vercel | 実処理の実行。Node.jsでRSS/API解析、本文抽出、分割計算、Gemini呼び出し、出力検証、DB保存 |
| Terraform | Cloudflare/Vercelのインフラリソースと設定をコード管理 |
| 既存PostgreSQL / Drizzle | 記事、本文、チャンクpayload、生成結果、最終要約を保持 |

無料枠での運用を目指す。無料稼働を保証済みとして扱わない。GeminiとDBの料金は別で、実クォータ・処理量・無料プラン適用条件を確認する。無料枠に収まらない場合は、処理量を絞る案、追加費用、未達の条件を計画に明示し、有料化を既定事項にしない。

Cloudflare Containers、Vercel Workflows、Vercel Cron、Inngest、Trigger.dev Cloud、Cloud Run Jobsへの構成変更は今回の要件に含まれない。バッチのPostgreSQL接続はVercelから行うので、Hyperdriveは現在の案では不要。Webを改修したり、記事DBをD1へ全面移行したりするタスクではない。

## 2. 最初に読むもの

次の順序で参照する。リンク先の構成案と図解は提案であり、実装仕様がすべて確定した文書ではない。

1. [AGENTS.md](../AGENTS.md)：作業範囲、TDD、コードの配置、secret、検証、ADR運用。
2. [ADR-0001](adr/0001-technology-stack.md)、[ADR-0004](adr/0004-batch-deployment-with-trigger-dev.md)、[ADR-0005](adr/0005-local-cli-trigger-task-deployment.md)：現在のAccepted構成。
3. [ADR-0008](adr/0008-cloudflare-control-vercel-execution.md)：新構成のProposed。採用・切替前に旧運用を置き換えたと解釈しない。
4. [改訂調査・移行計画](cloudflare-batch-migration-plan.md)：処理フロー、API候補、状態・認証・Terraform・無料枠の設計案。
5. [全体構成の図解](cloudflare-batch-migration.html)、[Gemini送信制御の図解](gemini-rate-limit-flow.html)：ユーザーへ説明済みの分担と待機フロー。
6. [バッチ・DB設計](news-summary-batch-db-design-v2.md)、[Gemini RPM実装計画](gemini-rpm-rate-limit-implementation-plan.md)、[Supabase接続手順](supabase-deployment-runbook.md)、[ADR-0007](adr/0007-session-pooler-release-migrations.md)：既存データと接続・実装の背景。
7. [Terraform運用手順](terraform-vercel-cloudflare-runbook.md)、[infra README](../infra/README.md)、[現行Trigger運用手順](server-deployment-runbook.md)：現在のIaC、デプロイ、停止・再開の入口。

実装計画には `news-summary-implementation-planner`、Cloudflareの調査には `cloudflare`、ADR作業には `adr-maintainer` を利用できる。planner skillにはsystemd運用の古い記述が残る。現在のAGENTS.mdとAccepted ADRを優先し、新しいsystemd timerを導入しない。今回のhandoff作成時点ではskills/harnessを変更していない。

## 3. 実装済みと未実装を区別する

### 現行コードで確認済み

- `runCollector()` はfeedを順次処理し、feed内の記事は `p-limit` で並列化する。
- アプリ設定の既定値は記事並列数2、feedあたり最大20候補、Gemini 5 RPM、429追加retry 2回、分割サイズ12,000文字。文字数をtoken数として扱わない。
- feedの既定対象はZenn、Qiita、はてなブックマークIT、Hacker News、GitHub Blogの5つ。これはコード上の既定であり、実運用設定の確認は未実施。
- Trigger taskはバッチ同時実行1、最大実行時間7,200秒。
- 1要約器・1プロセス内で、直近60秒のリクエスト開始数を共有するRPM limiterがある。
- 通常要約、各チャンク、最終統合、重要モデルから通常モデルへのfallback、429 retryは同じ送信関数を通る。
- 429には取得できるRetry-Afterまたはbackoff+jitterを使い、retry時もlimiterを通る。非429のAPIエラーは同じ送信関数内ではretryしない。重要モデルのfallbackは別の追加呼び出しになるため、記事全体のAPI回数とは分けて数える。
- 正規化URLにunique制約があり、要約済み記事はスキップしてmetricsを更新する。

### 未実装・未検証

- Cloudflare Worker / Workflows / Queues / D1 / DOのcollector資源とコード。
- Vercelのcollector用Node Functionsと双方向の認証HTTP。
- 分散RPM、TPM、RPD、permit、shared cooldown、チャンクの永続再開。
- operation table、本文/チャンクの中間保存、D1/PG間の結果照会・照合。
- collector用Terraform modules、環境別state、deploy CI。
- 無料枠に収まること、Google実クォータ、実環境の到達性・CPU・レスポンスサイズ。

現行の狭い検証として、次のコマンドは2ファイル・11テスト成功している。新構成や実APIが検証済みという意味ではない。

```sh
pnpm exec vitest run apps/collector/src/gemini-rate-limiter.test.ts apps/collector/src/summarizer.test.ts
```

図解の操作は通常送信、429、TPM不足、RPD終了の4ケースを確認し、PCと320px幅の表示も確認済み。HTMLの13秒間隔、TPM 10,000、1日100記事、記事並列4、feed並列3は説明・初期検証用の仮定で、実測済みの運用値ではない。

## 4. 現行コードの入口

| パス | 読む目的・計画での扱い |
| --- | --- |
| `apps/collector/src/execute-collector.ts` | 環境設定、feed選択、全feed失敗の扱い |
| `apps/collector/src/run-collector.ts` | 一括処理をdiscovery / extraction / chunk / merge / persistへ分ける対象 |
| `apps/collector/src/feeds.ts` | RSS/Atom/RDF・HN取得、候補解析。現在HNのitem取得は候補数までPromise.all |
| `apps/collector/src/content.ts` | RSS fallback、jsdom/Readability、分割計算。Node側へ維持 |
| `apps/collector/src/summarizer.ts` | Gemini SDK、モデル選択、各チャンク・統合、Zod、retryの分離 |
| `apps/collector/src/gemini-rate-limiter.ts` | 既存のprocess内RPM。分散化で単純流用しない |
| `apps/collector/src/config.ts`、`src/.env.example` | 既存設定と新しい非secret変数名の整理 |
| `apps/collector/src/persistence.ts` | transaction、operation claim、結果再利用、failure条件の変更対象 |
| `apps/collector/src/trigger/`、`trigger.config.ts`、`scripts/deploy-trigger.sh` | 移行完了まで維持する旧入口・切り戻し経路 |
| `packages/domain/src/` | URL正規化・score・記事schema。stage request/responseのZodを追加する候補 |
| `packages/db/src/schema.ts`、`client.ts`、`drizzle/` | 既存PG schema、TLS/pool、additive migration |
| `infra/modules/`、`infra/environments/production/` | Web project/domain/DNSの既存Terraform。無条件の共通module変更を避ける |
| `.github/workflows/terraform.yml`、`release-web.yml` | environment、branch、state lock、migration/deployの既存経路 |

DBの既知の懸念：現在の `saveArticle()` は記事・本文・要約・metricsを別々に保存し、最初に要約済み状態へ更新する。途中失敗で不完全な状態が残り得る。`markArticleFailed()` のupsertも他の成功処理を失敗へ戻し得る。分散化に先立ち、transactionと成功状態を保護する更新条件を計画する。unique制約だけでは重複したLLM送信を防げない。

## 5. 計画の前提フロー

```text
Cloudflare Cron → Feed Workflow → Vercel discovery（解析・候補保存）
  → D1 work + outbox → Queue → 実行枠取得 → Article Workflow
  → Vercel extraction（本文・チャンクpayloadをPGへ保存）
  → D1へchunk進捗登録
  → 未完了chunkごとにVercelへ依頼
      → 保存済みoperation結果の確認
      → Cloudflare DOへ送信permit要求
      → 許可ならGeminiへ送信 → PGへ結果保存 → CFへresult ID
      → 枠不足なら待機情報を返す → Workflow sleep → 再判定
  → Vercel merge / Zod検証 → Vercel persist（transaction）
  → D1完了 / job集計 → 定期照合
```

本文・prompt・生成結果をWorkflow stepやD1へ大きいJSONで受け渡さない。Cloudflareは小さい参照IDと制御状態を扱う。Vercelは1 invocationで1段階または1チャンクを同期処理し、応答後のbackground処理を永続実行の代替にしない。

## 6. 次の実装計画で確定する設計

| 項目 | 必ず計画に含める決定と成果物 |
| --- | --- |
| Vercel build | `apps/collector`配下の独立projectでのhandler配置、pnpm workspace build、Node version、依存bundle、deploy branch |
| API | discovery、extract、summarize-chunk、merge-summary、persist、operation-statusのversion付きZod契約。manifest照会・ページングも具体化 |
| deadlines | 各fetch/SDK/handler/WorkflowのtimeoutとAbort、期限超過時の保存済み結果照会。内部240秒案はPoCで確定 |
| PG | candidate、content/chunk payload、generated result、operation/claimに必要なtable/column/index、transactionと旧版互換migration |
| D1 | job、article work、chunk work、outbox、lease/attempt/error/next-run、保持期限と集計queries。PGとD1の責務を明文化 |
| state machine | pending/running/waiting/succeeded/failed等の遷移、terminal条件、retry分類、lease回収、古い所有者の書き込み拒否 |
| 冪等性 | operation key、stable Workflow ID、input/model/prompt version、API attemptとnonce/permitの違い、結果再利用の条件 |
| Gemini gate | project単位DO内のモデル別RPM/入力TPM/RPD、atomic reservation、cooldown、permit期限、重複permit、token見積もり、実usageとの照合 |
| 認証 | CF→Vercel・Vercel→CFの署名、request ID、body hash、expiry、nonce、環境、許可操作、secret rotation、必要時のdeployment protection |
| 二箇所の状態 | PG保存成功→CF進捗確定の順序。HTTP応答喪失、D1更新失敗、動作中timeoutをoperation照会とreconcilerで回復 |
| 並列・配送 | consumer枠とWorkflow枠を分離。ack時点、outbox再送、DLQ、backlog制限、RPD待機時の枠の保持/解放 |
| deploy version | work開始時のimmutable executor deployment/API version固定、古いdeployment保持、Workflow replay/進行中runへの互換性 |
| 監視 | API attempt数、token、429原因、quota待機、Queue滞留、D1/DO usage、Vercel CPU/memory、失敗stage、schedule欠落、secret非露出 |

計画の重要な未決事項：

- 無料Workflowのstep/subrequest予算内でArticle Workflowを維持できるか。長文とpermit待ちが多い場合、chunk単位の子Workflowへ分離する条件を決める。
- permit発行とVercelからの実送信の間には遅延がある。clock skew、permit期限、安全余裕、実際の送信開始をどう計測するか。図解の13秒間隔を仕様として転記しない。
- tokenizer / countTokens API等の入力token見積もり方式を決め、そのコスト・呼び出し数・精度も計画する。文字数換算だけで厳密なTPM保証を主張しない。
- 同じGoogle projectを別サービスで使う場合のgate集約か予算割当。別API keyなら制限が独立するとは扱わない。
- PGとD1に分散transactionはなく、LLM成功後の応答喪失で課金の完全な一回保証もない。回復できる状態と残る限界を明示する。

## 7. Terraform・CIの引き継ぎ

既存のlockはCloudflare provider **5.24.0**、Vercel provider **5.14.0**。制約は両方 `~> 5.0`。CIのTerraformは **1.11.4**。実装計画ではlockのschemaを確認し、latestのresource例をそのまま使わない。

- 新規候補module：`infra/modules/cloudflare-collector/`、`infra/modules/vercel-collector/`。
- CF候補resource：Worker、Cron、Workflow、Queue/DLQ/consumer、D1。DO SQLite class/migration/bindingsはWorker設定を通じて管理する。
- Vercel候補resource：collector project、Git/build設定、domain。既存Webのproject/DNSは維持する。
- 新しいbatch用staging/productionのroot moduleとstate keyを設計する。既存Web production stateを無条件で置換しない。
- remote stateは既存R2 S3 backendとlock方式を継承する。state bucketは別repositoryの管理対象であり、ここで新規作成・削除しない。
- runtime secret値はTerraform stateに入れない。`sensitive`指定だけではstateから値は消えない。CIによるsecret注入とTerraform再applyでの保持をPoCで検証する。
- WorkerコードはCIでbundleしTerraformからdeployする第一案。コード変更もinfra pipelineへ届くトリガーを設計し、Wrangler deployとbindings/Cronを二重管理しない。
- Vercelアプリコードdeploy、D1/PG schema migration、runtime instances/進捗はTerraform resource管理と区別する。
- Worker/Workflow/DOの初回作成依存関係、namespace migrations、secret注入、認証疎通、Cron有効化の順序を具体化する。
- Queue consumerは調査時点のlatest provider docsでimport非対応。既存資源を移す場合は固定versionを再確認する。新規作成を前提にした案が現在の第一候補。
- 現行CIは `release-infra` とGitHub environment承認、R2 lock/concurrencyを使用する。新規構成もその運用へ整合させる。

## 8. 計画作成時に取得する情報

次の値は未確認。最初の調査項目として列挙し、値がなくても作れるAPI/state/PR計画は先に進める。秘密情報の値をchatや文書へ貼り付けさせない。

| 確認する情報 | 判断に使う理由 |
| --- | --- |
| 実Cron間隔、1日の候補数・新規記事数・長文比率、現行run時間 | workflow数、step数、待機、無料枠と工数 |
| AI Studioの実モデル・RPM/TPM/RPD、projectの他用途 | gate設定と必要な余裕。現行model名が今も有効かも確認 |
| Vercel account/plan、用途のHobby適合性、Web等の既存usage | 無料枠の残量と利用条件 |
| Cloudflare account/plan、既存Workers/D1/DO/Queues usage | account共有枠とstate設計 |
| DB配置、staging/production分離、Vercelからの到達性/TLS/pool | 本文保存と切替の実現性 |
| 許容完了時間、記事件数の上限、費用目標、履歴保持期間 | backpressure、日次保留、監視、保存期限 |
| Terraform/GitHubの対象環境と権限、secret注入方法 | plan/deploy/bootstrapの順序 |

料金・制限・providerの機能は2026-10-10時点の調査。計画作成時に既存調査計画末尾の公式リンクで再確認する。無料枠、商用条件、実クォータはコードから推定して確定しない。

## 9. 作る実装計画の構成とPR分割

次の成果物は `docs/cloudflare-vercel-migration-implementation-plan.md` を第一候補とする。これはまだ存在しない。引き継ぎ書を転記するだけでなく、実際のpathと検証方法が決まった計画にする。

1. 要件・範囲・現行との差分・採用条件。
2. 起動〜完了と429/timeout時のsequence、state machine、データの正。
3. APIのZod契約、auth、operation/permit設計、payload境界。
4. PG/D1 schema案、migration順、rollback互換性、結果回復。
5. Terraform資源一覧・module/state/環境・ownership・bootstrap/deploy順。
6. Geminiゲート・quota設定・token見積もり・retry/cooldown仕様。
7. PR一覧、依存関係、各PRのfile責務・TDD・受入条件・検証commands。
8. staging比較、無料枠の実測と判断基準、production切替・監視・切り戻し。
9. 未決事項、計画時の仮定、見積もり。現在の10〜18作業日は暫定であり、PoCと設計の結果で見直す。

PR分割の叩き台：

| 順序 | 内容 | 前提・完了条件 |
| --- | --- | --- |
| 0 | build / auth HTTP / gate / provider bootstrapのPoC計画 | 検証項目と合否基準を定義。実施したら証拠と採用値を記録 |
| 1 | domain API契約・operation ID・state遷移 | 他層が利用できるschemaと失敗分類 |
| 2 | PG operation/payload・保存transaction | 既存Triggerと互換、並行claim/rollback/成功保護のテスト |
| 3 | D1 schema・queries・outbox・照合 | 制御状態の正とPG結果回復、duplicate通知で二重集計しない |
| 4 | Terraform / 環境・secret・CI基盤 | 通常deployとbootstrap、no-drift、既存Web/state保護。Cronは無効で作成 |
| 5 | Vercel stage handlers | 薄いadapter、認証/deadline、参照ID、再配送時の結果再利用 |
| 6 | DOの分散gate / CF Workflow / Queue | 全呼び出し経路のgate、quota/429/待機、ack、枠・lease回復 |
| 7 | staging受入・本番runbook・切替 | 実測、品質、復旧、drain、旧run停止、新Cron有効化、切り戻し |

順序は依存関係の叩き台。stage handlerとgate/状態設計は共通契約を先に確定する。Terraformとアプリコードはbootstrapの依存を確認して調整する。次の担当に複数エージェントの使用を要求するものではない。

## 10. 最低限の受入条件

- 同じURL、work、Queue message、HTTP retryで同じ記事の生成・保存を無制限に繰り返さない。
- 長文はチャンク単位で再開し、成功済み生成結果を再利用する。
- PG保存成功後の応答喪失/D1更新失敗を結果照会で回復し、成功記事を失敗へ戻さない。
- 複数Vercel invocationの通常/チャンク/統合/fallback/retryが全てproject共有gateを通る。
- RPM、TPM、RPD、permit期限、shared cooldown、attempt上限、日次境界をテストする。枠不足の待機と実API attemptを混同しない。
- Vercel timeout後の継続・遅延成功、lease期限切れ、再起動、deploy version変更で二重更新しない。
- Cloudflareの制御CPU、step/subrequest、Queue、D1/DO、Vercelの月間usageが許容枠に収まることを実測する。無料や429ゼロを無根拠に断言しない。
- Terraformで同じ資源を二重管理せず、再applyで不要な差分や永続状態の再作成がない。
- secret、本文、prompt、Gemini生応答をlogs、responseのエラー、Terraform state、fixturesへ漏らさない。
- 単一記事/feedの失敗は他の処理を継続し、全体成立不能のエラーを区別する。
- 本番切替時は旧Triggerと新Cloudflareで二重起動しない。切り戻しでD1/Queueの未処理workを保持する。

## 11. 検証計画の作り方

変更する層はAGENTS.mdに従ってTDD。アプリの狭いテストを先に定義し、その後に必要な全体回帰を計画する。

```sh
pnpm format:check
pnpm lint
pnpm --filter @upto/collector test
pnpm --filter @upto/collector typecheck
pnpm --filter @upto/domain test
pnpm --filter @upto/db test
pnpm typecheck
pnpm test
```

Terraformは `fmt -check -recursive`、各新規rootの `init -backend=false`、`validate`、固定provider schemaの確認と、環境接続可能な段階での `plan` を含める。planのcreate/update/deleteが既存Web・DNS・R2 backendへ波及しないことを確認する。文書しか変更しない段階でapplyやアプリ全体テストを実施済みとして記録しない。

追加でCloudflare runtimeのD1/DO/Workflowテスト、Vercel Node build、stagingの双方向auth・timeout・再配送・CPU計測が必要。Web UIを変更しなくても、最終保存された記事が既存フィードに正しく出ることを既存Playwrightで確認する。採用packageと確定pathに応じて実行可能なcommandsを計画へ記載する。

## 12. ADR、ワークツリー、作業範囲

- ADR-0008は **Proposed**。要件の指定と、具体設計・PoCの合格を同一視しない。採用時はappend-onlyのルールで状態履歴と旧ADRの置き換え範囲を追記する。
- ADR-0004/0005の末尾にはADR-0008が提案中である旨を追記済み。Accepted本文は維持している。
- 現在の作業ツリーには前の調査・図解による変更が未commitで存在する。`git status --short`で確認し、他の変更も含めて保持する。reset/clean/上書きで消さない。
- 新コードの主な配置は `apps/collector`、共有契約は `packages/domain`、PG/D1 schema/client/queryは `packages/db`、IaCは `infra`。既存AGENTSのTrigger前提は採用後に新ADRと整合させる。
- 次の依頼は **移行実装計画の作成**。このhandoffだけを根拠に本番deploy、Terraform apply、旧schedule停止、DB実migrationを開始しない。
- 実装後、本書と暫定計画の内容がコード・tests・runbookで置き換わったら、古くなったhandoffを整理する。ADRと永続運用runbookは保持する。

## 次の担当へ渡す開始文

> `docs/cloudflare-vercel-migration-planning-handoff.md` を読み、Cloudflare管理・Vercel実行・Terraform管理の要件を維持して、移行実装計画を作成してください。現行コードとADRを確認し、API契約、PG/D1状態とmigration、分散Gemini gate、認証、Terraform資源・bootstrap、PR分割とTDD、無料枠の実測、staging受入、本番切替・切り戻しまで具体化してください。未検証の値は仮定として扱い、現在の未commit変更を保持してください。今回は計画作成を成果物とし、deploy/applyや本番停止は行いません。

## 2026-10-10追加要件: ローカル品質保証とActions運用

[ローカル品質保証・Actions設計](cloudflare-vercel-local-quality-plan.md)を移行実装の受入仕様として追加する。全機能に正常系・境界・障害回復のローカルテストを設け、実PG、workerdのD1/DO/Workflow、Node HTTP、全体障害注入、Web互換、IaC/CI契約を検証する。新コマンドと新基盤テストは現時点で未実装。実クラウドのCPU・quota・権限はstagingで別途確認する。

TerraformのPlan / ApplyはGitHub Actionsを前提にし、確定commitの保存Planを差分レビュー・Environment承認後に適用する。Apply時の再計画は行わない。bootstrap・Workerコード変更・Cron切替もこの経路へ統一する。

**現在Actionsで使うトークンは新規リソース作成の権限が不足している（ユーザー申告）。初回Plan / Apply前にCloudflare/Vercelの権限を棚卸しし、トークン更新・再発行とEnvironment Secretsの差し替えが必要。更新・実権限検証は未実施。** Zone Read / DNS EditだけのWeb用Cloudflare tokenでは新collector資源を作成できない。詳細なscopeと更新手順は上記設計書に従う。
