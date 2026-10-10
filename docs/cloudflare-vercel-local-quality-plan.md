# Cloudflare / Vercel移行のローカル品質保証とActions設計

作成日: 2026-10-10
状態: 移行実装の受入仕様。以下の新コマンド・tests・workflowsは未実装。

[移行実装計画](cloudflare-vercel-migration-implementation-plan.md)を補完する。全機能の正常系・境界・障害回復をローカルで再現するテストを、機能実装と同じPRで追加する。ADR-0008はProposedのまま。本書の追加でdeploy、Apply、実migration、旧Trigger停止は行わない。

## ローカル構成と責務

| 層 | 実行方法 | 検証するもの |
| --- | --- | --- |
| domain / policy | Node Vitest、fake clock、固定乱数 | 契約、key、状態遷移、retry、予算とdeadline境界 |
| PG repository | 隔離した実PostgreSQLとDrizzle migration | SQL、unique、transaction、同時claim、fencing、rollback |
| CF control | workerd上のWorkers Vitest integration / built Worker test harness | 実D1 SQL、SQLite DO、Queue handler、Cron、Workflow再開 |
| Node Functions | 薄いVercel adapterを通すローカルHTTP server | raw body署名、query、制限、stage、参照照会、deadline |
| 全体 | local Worker + Node HTTP + PG + fixture HTTP/Gemini server | Cron起動から公開・再配送・復旧まで。両方向で実署名を使う |
| Web互換 | 保存済みfixture記事を読むNext.js + Playwright | フィード・詳細表示、モバイル/PC、キーボード、空/失敗状態 |
| IaC / CI | Terraform offline validate/test、workflow契約テスト | 資源・binding・保護設定、環境分離、Plan/Applyゲート |

公式の[Workers testing](https://developers.cloudflare.com/workers/testing/)と[Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)を参照し、既存Vitest 5と互換の固定versionをPoCで選ぶ。NodeテストからCF専用APIをimportしない。Workflowは公式の[test APIs](https://developers.cloudflare.com/workers/testing/vitest-integration/test-apis/)のintrospection等で失敗・待機・再開を検証する。必要な機能が選定versionで未対応なら補助harnessを追加し、mockだけでruntime検証済みにしない。

ローカルbindingを使い、remote bindingsを無効にする。外向きネットワークはfixture server以外拒否し、Gemini生成・token計測・feed/article HTTPを差し替える。失敗注入はclock、HTTP transport、応答喪失、repository境界を通じて行い、本番APIにテスト専用endpointを公開しない。

PGは専用compose serviceで起動し、ホストDocker socketをcontainerへmountしない。テスト接続先はloopbackと専用DB名をallowlistし、本番URLや不明な接続先を拒否する。workerごとにDB/schemaとD1/DO storageを隔離し、毎回migrationから初期化する。fixtureには架空本文・ダミー鍵だけを使い、実記事、token、DB URL、Gemini生応答を入れない。再起動試験では対象storageを保持し、その試験終了時にのみ削除する。

## 全機能の必須テスト

以下の各行をtest file / caseに紐付ける一覧をPRごとに更新する。skip、todo、未実装は合格に数えない。assertは状態だけでなく生成回数・DB行数・集計・lease/permit数も確認する。

| 機能 | 必須のローカルケースと判定 |
| --- | --- |
| API契約・識別子 | 全stageとmanifest/status/finalize、invalid/余分なfield、version不一致、環境/参照ID混同、同じ入力の安定key、入力相違409 |
| discovery | 全登録feed形式、RSS fallback、HN item並列上限、重複URL・別feed、slot重複、1 feed失敗継続、全feed失敗、候補上限 |
| fetch / extract | Readability、空/壊れたHTML、byte/redirect/timeout上限、private/loopback/link-local拒否、redirect後の再検査、単一/複数/最大chunk、generation join |
| manifests | snapshot固定、cursorの環境/manifest所属、paginationの欠落/重複なし、空/最終page、request/response byte上限 |
| summarize / merge | 通常・chunk・順序付き統合・fallback・retryの全経路がgateを通る、Zod不合格、成功chunk再利用、attempt上限、token計測失敗時に送信しない |
| 認証 | 正常署名、raw body/query/method/path改ざん、期限/時計差境界、nonce同時再送、key ID不明、旧新鍵rotation、deployment/version不一致、bypassのみでは許可しない |
| operation / PG | 同時claim、別jobの同一generation、各保存点rollback、成功保護、古いepoch拒否、成功commit直後の応答喪失、遅延成功、uncertainで自動生成再送なし |
| D1状態 | 全合法/不正遷移、CAS競合、重複完了/集計、atomic outbox、PGとD1の独立epoch、job partial/fatal/cancelled、単一記事障害で他を継続 |
| outbox / Queue / DLQ | send前/後クラッシュ、send成功応答喪失、重複/順序逆転、Workflow作成失敗、作成確認前にackしない、配送上限とDLQ、保持期限超過をD1から回復 |
| Workflow | stable instance ID、checkpoint、step/request予算境界、途中再起動、長期待機で新resume、成功chunk保持、cancel/drain、旧version replay |
| capacity DO | 同時取得上限、feed/stage/in-flight枠、期限回収、二重解放、待機時解放、再起動後も枠保持、古い所有者の操作拒否 |
| Gemini gate DO | RPM/TPM/RPDの上限直前/一致/超過、同時reserve、consume一回、期限切れ/未送信予約回収、shared cooldown/429、モデル別とproject共有予算、usage誤差、太平洋時間の日次境界と夏時間 |
| deadline / retry | fetch/gate/LLM/DB/handler timeout、遅延成功照会、400/401/403をretryしない、HTTPとGemini retryを二重計数しない、quota待機でattemptを増やさない |
| finalize / persist | 公開記事・本文・要約・metrics・operationの原子保存、再実行結果一致、count version競合、既存Trigger/Web互換 |
| reconciler / cleanup | D1確定漏れ、stale lease、next-run再配送、backlog/deadline超過、参照中payload/旧deploymentを消さない、保持期限/nonce削除 |
| 運用制御 | Cron UTC slot、paused/active/drain、quota不足で新discovery停止、切替時に旧新二重起動なし、切り戻し後にstate保持し再開 |
| logs / errors | 全失敗経路でtoken/署名/body/prompt/生応答を出さない、sanitized codeと追跡ID、config不足は起動失敗 |
| Terraform | staging/production state分離、Web/DNS/backend不変、Cron/consumer初期無効、永続資源削除保護、bindings/class/migration整合、runtime secret値を設定に含めない |
| Actions | forkのsecret不使用、必須test失敗で停止、許可ref以外のApply禁止、Plan失敗で停止、同じcommit/bundle/PlanのみApply、承認前にApplyなし、state排他 |

最低限の全体シナリオは「短文正常」「長文途中停止と再開」「重複配送」「PG commit後応答喪失」「D1確定失敗と照合」「429/日次予算待機」「deadline後の遅延成功」「deploy version更新中再開」「drainと切り戻し」。各ケースで二重公開0、成功状態の逆戻り0、成功chunk再生成0をassertする。fixtures内の並列競合は複数DB接続・複数HTTP invocationで再現し、単一mockの逐次呼出だけで合格にしない。

## 実装するコマンドとCIゲート

以下は予定するroot scripts。PR 2〜6で実装し、実装済みのコマンドだけをrunbookへ移す。

| コマンド案 | 内容 |
| --- | --- |
| `pnpm test:local:up` | 専用PG起動・healthcheck。実行ごとに隔離したstorageを準備 |
| `pnpm test:local` | domain/Node、PG migration/integration、CF runtime、HTTP全体、Web互換を順に実行。どれか失敗なら非0 |
| `pnpm test:local:down` | 対象テスト環境のみ終了・掃除。失敗時もCIのalways cleanupから実行 |
| `pnpm test:infra` | 全rootのfmt/init backend=false/validate、mock providerによるTerraform test、workflow契約テスト |
| `pnpm verify:local` | format/lint/typecheck、上記local/infra tests、credentialなしNode/CF build |

Terraform testは固定1.11.4のmock providerを使い、実API/remote stateへ接続しない。provider downloadの初回ネットワークは必要で、完全air-gap対応を意味しない。権限やproviderの実作成動作はmockで保証しない。

ローカルHTTPテストは同じNode adapterとbundleを使う。credentialなしbuildと、Vercel設定を取得して行う `vercel build` は別にし、後者はstaging CIで検証する。Webの既存PlaywrightがAPI mockを使う場合、それに加えて今回保存したPG記事を実APIから読むケースを設ける。

GitHub Actionsのcredentialなしverify jobで同じ `verify:local` を実行する。変更pathで一部検証を省略する場合でもcollector/domain/db/build/lock/IaC/workflow変更は全体ゲートに含める。テスト未対応を成功扱いにせず、PoC未達は採用の阻害条件として記録する。

## ActionsのPlan / Apply

PlanとApplyはGitHub Actionsを通常経路にする。bootstrapの各phase、Workerコード変更、Cron有効/無効、rollbackも同じ経路で行う。

1. PR: credentialなしtests/build/validate。forkにはsecretを渡さない。レビュー対象の同一repository PRで必要ならEnvironment承認後に参考Planのみ実行し、PRコードを `pull_request_target` でsecret付き実行しない。
2. `release-infra`確定commit: tests合格後、対象実装commitのbundleを固定しhash・API/config version・root/state keyをmanifestへ記録。認証済みinit後に `terraform plan -out=tfplan`。PR Planは再利用しない。
3. 差分レビュー: create/update/delete、永続資源replacement、既存Web/DNSへの波及、secret保持、Cronの状態を確認。Plan完了後にApply jobのEnvironment Required reviewersで承認する。Plan前の承認だけで代用しない。
4. Apply: 同じrunの保存Plan・lockfile・bundle・manifestを取得し、commit/hash/環境の一致を検査。 `terraform apply tfplan` で適用し、再planや `apply -auto-approve` へのfallbackは設けない。
5. stale Plan・欠損artifact・不一致は停止し、再Planと再承認。state keyごとのActions concurrency（cancelしない）とR2 lockで排他。PG migrationは既存Web releaseとの共通排他を維持する。
6. 成功後: secrets保持、schema/API互換、no-drift Plan、manifest照合を確認してから新規workを受付。bootstrap中はCron無効。

[保存Planは機密値を平文で含み得る](https://developer.hashicorp.com/terraform/cli/commands/plan)ため、raw Plan/state/JSONを公開artifactやPRコメントへ置かない。job間転送はEnvironment Secretの鍵で暗号化したPlanを短期保持し、復号権限はApply環境に限定する設計にする。bundleも同じrun/commitに固定する。公開可能なsummaryは差分の資源名と操作だけに絞る。CI契約テストとstaging演習で未承認・別commit・別環境・stale PlanがApplyされないことを確認する。

## Actionsで使うトークンの更新

**現在のActions用トークンは新規リソース作成の権限が不足している（ユーザー申告）。Cloudflare/Vercelへの移行前に権限を見直して更新・再発行し、GitHub Environment Secretsを差し替える必要がある。トークン更新は未実施。**

| credential | 必要な操作 / scope | 更新時の確認 |
| --- | --- | --- |
| collector用 `CLOUDFLARE_API_TOKEN` | 対象accountのWorker script/settings/Cron/DO設定、Workflows、Queues/consumer/DLQ、D1作成・migration、Worker secret注入 | 各固定provider/APIのRead/Create/Update権限を対応づける。DNS tokenの流用だけでは不足 |
| DNS用Cloudflare token | 必要な対象zoneのZone Read / DNS Edit。collector専用domainを作る場合のみ追加 | Webの既存tokenを不用意に広域化しない。route/custom domainを使うなら該当権限も確認 |
| `VERCEL_API_TOKEN` | 対象teamのcollector project新規作成、設定、必要domain、code deployment、runtime secret更新 | 既存Web projectだけのscopeでは新規project作成可能と仮定しない |
| `TF_R2_ACCESS_KEY_ID` / `TF_R2_SECRET_ACCESS_KEY` | state bucketのcollector stateとlock objectの読書き・lock削除 | bucket作成/削除は不要。既存のkey制限が新state keyを許可するか確認 |

Cloudflareの[Workers権限](https://developers.cloudflare.com/workers/authorization/workers/)は他製品の権限を代用しない。[permission groups API](https://developers.cloudflare.com/api/resources/user/subresources/tokens/subresources/permission_groups/methods/list/)と固定providerが呼ぶ各endpointのaccepted permissionsを照合し、正確な権限名/IDを実装PRに記録する。表示名だけから必要権限を推測してGlobal API Keyや全account管理権限へ広げない。

更新手順:

1. Terraform resource / deploy / migration / secret注入ごとのAPI操作と対象account/team/zoneを棚卸しし、PlanとApplyそれぞれに必要なscope・有効期限を決める。
2. 管理画面で新tokenを作成し、collector-staging/productionのGitHub Environment Secretsへ登録する。値をチャット、repo、tfvars、log、artifactへ出さない。secret名はworkflowと一致させる。
3. token verifyとread API、Actions Planを実行する。これだけではCreate権限の検証は完了しない。
4. 承認したstaging PlanをApplyし、新規資源作成・設定・secret注入・migrationを確認する。再Apply no-driftも検証する。productionは別Plan/承認後に実行する。
5. 移行期間中の旧workflow依存を確認して旧tokenを失効する。権限・期限・更新日・担当を非secret台帳/runbookに記録し、期限前の更新を運用に組み込む。401/403時は自動retryを繰り返さず権限不足として停止する。

## ローカル試験では確定できない受入条件

全機能のロジックをローカル試験の対象にする一方、Cloudflare/Vercelの実CPU/実行時間/usage/保持仕様、実tokenの作成権限、provider secret保持、Vercel deployment protection、実Gemini quota/要約品質はstagingで別途確認する。ローカル合格を本番性能・無料枠・実API権限の保証として扱わない。

[実装計画の受入](cloudflare-vercel-migration-implementation-plan.md#10-無料枠の計測監視受入)に実測結果を残す。ローカル全ケース合格、Actionsで承認済みPlan/Apply、トークン更新、staging受入のすべてが揃うまで本番切替条件を満たさない。
