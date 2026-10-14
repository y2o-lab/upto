# バッチ基盤のTerraform実装計画

作成日: 2026-10-11

ステータス: 実装前の計画

改訂日: 2026-10-11。Terraform設定・依存関係の抜けと、付随するCI／運用の前提を補足。

## 目的と前提

Cloudflareがバッチの起動・進捗・再試行を管理し、Vercel Functionsが記事取得・本文抽出・Gemini要約・PostgreSQL保存を実行する移行先について、インフラ構成をTerraformで管理する。

既存WebのTerraformと稼働構成を維持し、バッチ専用のstaging／productionを追加する。初回構築ではCron・Queue consumer・新規受付を無効にし、接続と実処理を検証してから有効化する。

[ADR-0008](adr/0008-cloudflare-control-vercel-execution.md)はProposedであり、本計画の作成やTerraformコードの追加だけでは現行Trigger.dev運用を置き換えない。採用・本番切替時にADRの採用履歴と旧ADRの置換範囲を追記する。

## 現在の実装状況

| 対象 | 状況 |
| --- | --- |
| 既存Web用Terraform | Vercel project、domain association、Cloudflare DNSを実装済み |
| Vercel向けcollector API | ローカル実装済み。deployとCloudflareからの接続は未完了 |
| PostgreSQLのcollectorテーブル | schema・migration・保存処理を実装済み。本番適用は未実施 |
| Cloudflare制御コード | 未実装 |
| collector用Terraform・CI | 未実装 |
| 現行バッチ | 設計・運用資料上はセルフホスト版Trigger.devを継続 |

上記はリポジトリと運用資料に基づく。実環境の接続、権限、クォータはこの計画作成では照会していない。

## 実装範囲と責務

| 対象 | Terraformの管理内容 |
| --- | --- |
| Vercel | collector専用project、Node.js・build設定、domain association |
| Cloudflare DNS | collector用A／CNAME、必要な所有権検証TXT |
| Workers | CIで作ったbundleの配置、bindings、compatibility設定、observability |
| Workflows | Feed／Article Workflowの定義とWorkerへの紐付け |
| Queues | 記事Queue、DLQ、consumer、retry・concurrency設定 |
| D1 | 制御状態用databaseとbinding |
| Durable Objects | Capacity／Gemini Gateのclass・binding・SQLite namespace migration設定 |
| Cron | UTCでの起動スケジュールと有効・無効設定 |

Workerコードの配置はTerraformに集約する。Wranglerによる同じWorker・bindings・Cronの二重管理は行わない。Vercelのアプリコードdeployment、PostgreSQL／D1のtable migration、runtime secret注入はCIの別工程とする。Workflow instance、記事データ、DOの業務データはTerraform resourceにしない。

Cloudflareの実処理制御コードとD1 repositoryの実装は、Terraformと接続する別作業である。Terraform単体でバッチ全体の完成とはしない。

以下の資源・binding・起動設定はTerraformの実装範囲、保存Planの保護・DB migration排他・API有効化は付随するCI／運用の実装範囲として区別する。

## Terraform設定の実装仕様

resource名は固定providerで確認する候補であり、未検証の属性を使用可能と扱わない。

| 構成 | resource候補／実装内容 | 依存先 |
| --- | --- | --- |
| collector project | `vercel_project`。rootを`apps/collector`、frameworkなしとし、既存`vercel.json`と整合するNode／install／build設定 | Vercel scope |
| collector domain／DNS | `vercel_project_domain`、domain config照会、`cloudflare_dns_record` | project → domain association → 推奨target照会 → DNS |
| D1 | `cloudflare_d1_database`、削除保護 | account |
| Queue／DLQ | `cloudflare_queue`。保持期間・配送上限を明示 | account |
| control Worker／Gate入口 | `cloudflare_workers_script`。bundle・compatibility date／flags・observability・外部secret保持設定 | D1、Queue、DO migration |
| DO | Workerのclass export、SQLite migration tag、namespace binding。独立したDO instance resourceは作らない | 対応classを含むWorker |
| Workflow | `cloudflare_workflow`。Feed／Articleのclass名とscript名を固定 | Workerの初回upload |
| consumer | `cloudflare_queue_consumer`。retry・concurrency・DLQ接続を設定 | Queue、DLQ、対応Worker |
| Cron | `cloudflare_workers_cron_trigger`。収集・復旧処理のUTC scheduleを一元管理 | 対応Worker・全binding・接続確認 |

Workerが必要とするD1、Queue producer、Feed／Article Workflow、Capacity／Gemini Gate DOのbindingを一覧化し、runtimeで参照する名前、resource ID、export class、環境をTerraformテストで照合する。実際のWorker分割とbinding名はPR 2でruntime契約に合わせて確定する。

入力は環境、account／zone／team ID、資源名、domain、bundle path／hash、compatibility設定、bootstrap phase、consumer有効化、収集／保守Cron、control mode、並列数、retry／保持、Gemini予算などの非secret値に限定する。環境名、HTTPS接続先、正の上限値、許可したmode／phaseを検証する。

bootstrap phaseは基礎資源 → 初回Worker（Workflow bindingなし）→ Workflow登録 → 全binding追加 → consumer → Cronの段階を表す。固定providerの依存関係に合わせてphaseを確定し、各phaseをActionsから同一rootに適用する。通常更新でphaseを戻してWorkflow／consumer等を削除しない。実行コードと接続が未完成の状態でconsumer／Cronを有効にする設定はCIゲートで拒否する。

Vercelのproduction／previewコードdeploymentはCIを唯一の経路とする第一案とし、Git連携する場合もcollectorのGit自動deploymentを停止する設定を追加する。既存WebのGit設定は変更しない。CLIからのdeploymentは維持し、Git pushだけではcollectorがdeployされないことを確認する。固定providerで管理できるproject設定と`apps/collector/vercel.json`の所有範囲を明示する。

Vercelの非secret runtime設定も一覧化する。実行有効化、各version、Gemini model、Gate origin／key ID、DB pool上限はCI注入を管理元とし、Terraformが環境変数を削除・上書きしない設定を検証する。Deployment Protectionの適用範囲とautomation bypassの要否はstagingで確認し、必要な場合もbypassをHMACの代替にしない。

### 収集・復旧処理の起動設定

| 処理 | 起動経路の第一案 | paused／drain時 |
| --- | --- | --- |
| 記事収集 | 収集CronからFeed Workflow。UTC slotを明示 | 新規起動しない |
| outbox送信 | 保守Cronのscheduled handlerから期限到来分を送信 | pausedでは配送停止。drainでは新stage投入を止める |
| reconciler | 保守Cron、暫定5分周期 | 既存処理の状態照会・完了反映は継続。再配送はmodeに従う |
| cleanup | 保守Cronのhandlerで日次slotを判定 | 未完了work・参照中payloadは削除しない |
| schedule watchdog | 保守Cronで予定収集slotの欠落を検出 | paused／drainでは収集を補完起動しない |

周期を共有する処理は同じWorkerのscheduled handlerから振り分ける。同じscriptのCron集合を複数resourceから管理しない。ページ件数・処理時間・削除件数の上限を設定し、slotの重複実行をruntimeで排除する。bootstrap中は収集・保守Cronとも無効、本番drain中は必要な照会用の保守Cronを維持する。監視は欠落slot、outbox滞留、lease期限切れ、DLQ、予算不足を対象とし、ログ／通知接続設定と責務をrunbookへ記載する。

## ファイル構成

```text
infra/
├── environments/
│   ├── production/                 # 既存Webを維持
│   ├── collector-staging/          # 新規root module
│   └── collector-production/       # 新規root module
└── modules/
    ├── vercel-collector/           # 新規。Web専用moduleから分離
    ├── cloudflare-collector/       # 新規。Worker、D1、Queue、Workflow等
    ├── vercel-domains/             # 既存moduleを再利用
    └── dns/                        # 既存moduleを再利用
```

新rootには`main.tf`、`variables.tf`、`outputs.tf`、`providers.tf`、`versions.tf`、`backend.tf`とprovider lockfileを配置する。Terraformテストは対象module／rootに`tests/*.tftest.hcl`として追加する。

CIは`.github/workflows/terraform-collector.yml`を追加する第一案とする。Vercel deployment・migration・secret注入との連携工程も定義する。既存Web用workflowの挙動は、この作業で広く変更しない。

`infra/README.md`、[Terraform運用手順](terraform-vercel-cloudflare-runbook.md)、[collector運用手順](cloudflare-vercel-collector-runbook.md)、[システム構成資料](system-architecture.md)を実装状況に合わせて更新する。

## 環境とstateの分離

- 既存Webのstate keyは維持する。
- 既存R2 bucket内に`collector-staging/terraform.tfstate`と`collector-production/terraform.tfstate`を追加する。
- 外部リポジトリ管理のR2 bucket自体は作成・変更・削除しない。
- project、Worker、Workflow、Queue、D1、domain、署名鍵は環境別に分離する。stagingの試験で本番記事を更新しないDB接続先を用意する。
- state keyごとのActions concurrencyとR2 lockを併用する。
- D1と永続DO namespaceを持つWorkerには削除保護、backup、restore手順を設ける。class名・namespaceの安易な変更やmigration tagの再利用を避ける。

DNS操作はzone限定token、Worker等の操作はaccount限定tokenとし、必要ならCloudflare provider aliasを分ける。既存Webの資源を新stateへimportしない。新domain／資源名が既存資源と競合しないことを実Plan前に確認する。

Geminiのstaging／productionは別Google projectを第一案とする。同じGoogle projectを使う場合、環境別DO namespaceだけでは共有quotaを制御できないため、共通Gateと環境別sub-budgetを接続仕様へ追加する。どちらの方式かをPR 2前に確定し、既存移行計画のGoogle project単位の予算管理を守る。

既存lockfileはCloudflare provider `5.24.0`、Vercel provider `5.14.0`である。新rootもこのversionを起点に固定し、必要なresource・属性を実際のprovider schemaで確認する。更新が必要なら独立した変更として検証し、既存Webのproviderを同時に更新しない。

## URLと認証の連携

Terraformはcollector projectとcustom domainを関連付け、Vercelの推奨targetを使ってCloudflare DNSを設定する。既存方針に従いVercel向けDNSは`proxied = false`を維持する。`/api/v1/*`のパスはアプリコードが定義する。

outputにはproject ID、collector domain、Worker接続先、D1／Queue／Workflowの識別子などの非secret値を出す。CIはこれらを用いてCloudflare側のVercel接続先と、Vercel側の`COLLECTOR_GATE_ORIGIN`を設定する。

GateのHTTPS入口は環境別Workerの`workers.dev` URLを第一案とし、subdomainとURLの取得／有効化が固定providerで可能か確認する。利用できない場合は専用custom domain／route資源とDNSを追加し、その権限も確認する。originはpath・queryなしのHTTPSとし、Gate入口に署名検証を設ける。Worker配置だけで外部から到達可能になると仮定せず、実URLの疎通をbootstrapの完了条件にする。

進行中workには開始時のVercel deployment URL／IDとexecutor versionを保持する。custom domainの切替だけで処理途中の実行versionを変更しない。未完了workが参照する旧deploymentは保持する。許可する接続先を固定し、redirect先へ署名を無条件転送しない。

APIはインターネットから到達可能なHTTPS入口で、実処理の前にHMAC署名、有効期限、nonce、環境、通信方向を検証する。TerraformによるDNS設定だけでCloudflare以外からの通信を遮断する構成にはならない。

secretはTerraform変数、resource、output、stateへ値を渡さず、CIから各サービスのsecret storeへ注入する。

| 注入先 | 主なsecret |
| --- | --- |
| Vercel | `DATABASE_URL`、必要なCA、`GEMINI_API_KEY`、`COLLECTOR_NODE_AUTH_KEYS`、`COLLECTOR_CURSOR_KEY`、`COLLECTOR_GATE_KEY` |
| Cloudflare | Cloudflare→Vercel署名鍵、Vercel→Gate検証鍵、必要なautomation bypass token |
| GitHub Environment | deploy用API token、R2 state／lock用credential、runtime secret注入の入力 |

Cloudflare側のsecret名はruntime契約の実装時に確定する。`sensitive`指定だけではstateへの保存を防げない。固定providerでsecret bindingの保持設定を検証し、再Applyでsecretが消えないことと、read-backで秘密値がstateへ入らないことを確認する。保持できなければCronは有効化せず、deploy方式を再検討する。

## 実装順序とPR分割

### PR 1: provider確認・root分離・Vercel／DNS

1. 必要resourceと属性をschemaで確認する。Workflow／Worker初回作成順序とsecret保持の実環境PoCはPR 2で実施する。
2. 作成権限、state key、環境別domain／DB接続先を確認する。
3. collector専用root、backend、lockfileを追加する。
4. `vercel-collector` moduleとdomain／DNS連携を追加する。
5. validateとTerraformテストに加え、最小の承認付き保存Plan／Apply経路をCIに追加する。Plan保護・ref制限・環境分離・排他はこの時点で実装する。

完了条件: 構成が検証でき、stagingのPlanにcollector資源のみが出る。既存Web・DNS・R2 bucketへの変更がない。実資源を作成する場合は後述のActions経路を使う。

### PR 2: Cloudflare基盤とbootstrap

1. D1、Queue／DLQ、Worker、Workflow、DO設定を追加する。
2. Cron無効、consumer無効、control mode pausedを既定値にする。
3. runtimeとbinding名・exportするclass名・bundle形式を合わせる。
4. 初回uploadとWorkflow登録の依存関係をbootstrap設定で表現する。
5. secret保持、削除保護、環境分離のテストを追加する。
6. PR 1のActions経路でstagingのbootstrap・secret保持PoCを実施し、起動設定、Gate URL、全bindingの契約を確定する。必要なclassをexportする停止状態のbundleをこのPRのCIで作成し、commit／hash／manifestを固定して保存Planと対応させる。secret注入と再Apply確認もPoC経路へ含め、mockだけで完了としない。

完了条件: 必要なruntime bundleが揃った時点で、停止状態の基盤を作成できる。Workflowが既存Workerを要求する循環を解決し、常用の手動`-target`に依存しない。

### PR 3: ActionsによるPlan／Applyとdeployment連携

1. PR 1のcredentials不要検証と承認付きPlan／Apply経路を、Worker bundleとdeployment連携へ拡張する。
2. 対象commitからWorker bundleを作り、hashを固定する。
3. `release-infra`の確定commitで保存Planを生成する。
4. 別のEnvironment承認後、同じ保存PlanをApplyする。
5. Vercel deployment、PG／D1 migration、secret注入、release manifestと連携する。
6. collector・共有package・lockfile・build設定の変更でも検証／deploy経路が起動するようpathsを設定する。

完了条件: commit、環境、bundle hash、Planの対応を検証できる。Apply時に再計画しない。state変更でPlanがstaleになった場合は失敗させ、再Plan・再承認する。forkへsecretを渡さない。

PR 1 → PR 2 → PR 3 → PR 4の順とする。PR 2の実環境PoCには最小の停止bundle、PR 4には本実装のCloudflare runtimeとD1 repositoryが必要である。runtime未完成をTerraformの完了として扱わず、該当段階の未達として記録する。

### PR 4: staging接続・本番切替設定

1. Cloudflare runtimeとD1 repository実装の完成後、手動workで各stageを接続する。
2. auth、Gemini Gate、状態照会、再試行、進捗の定期照合を検証する。
3. staging Cronを有効化し、受入条件を計測する。
4. productionは停止状態で作成し、切替条件成立後にCron設定を変更する。
5. 運用手順、構成資料、ADR採用履歴を更新する。

完了条件: API接続だけでなく、Cronから公開記事保存までを確認する。本番切替には既存移行計画の全体受入条件を適用する。

## Terraformに付随するCI／運用の条件

- Terraform CLIは既存品質仕様に合わせて`1.11.4`に固定し、lockfileを固定してinitする。PR検証にはmock providerを用い、実API・remote stateへ接続しない。
- Planは機密情報を含み得る。raw Plan／state／JSONを公開artifactやPRコメントに置かず、Environment Secretを使って暗号化したPlanを短期保持する。復号権限はApply環境に限定し、公開summaryは資源名と操作に絞る。保持期限と削除手順はPR 1で確定する。
- ApplyはPlan後のEnvironment承認を必須とし、同じrunのPlan・lockfile・bundle・manifestのみ使用する。許可ref以外、必須検証失敗、未承認、artifact欠損・hash不一致・stale Planでは停止する。`apply -auto-approve`による再計画へfallbackしない。
- PR Planは参考用でApplyへ再利用しない。`pull_request_target`でPRコードをsecret付き実行しない。
- 同じPostgreSQLを使うWebとcollectorのmigrationには共通排他を設ける。既存`release-web.yml`の`production-release`と整合する共有migration jobのconcurrencyを設計し、workflow全体の別ロックとの循環待ちを避ける。migration失敗時は以後のVercel／Worker更新と受付を停止する。
- Applyやsecret注入が途中失敗した場合はconsumer／Cronを有効化せず、現在phase・保存結果・必要な再Planをrunbookへ記録する。通常deployでは進行中workの互換性を保ち、新executorへの切替を止める。

## 初回bootstrapと通常deploy

初回は次の順序を基本とし、provider PoCの結果で依存関係を確定する。

1. 権限・state・backupを確認し、Cron／consumer無効、control pausedで開始する。
2. D1、Queue／DLQ、Vercel project、domain／DNSを作成する。
3. PostgreSQL／D1 migrationを適用する。
4. Worker／Workflow／DOのbundleを配置し、namespace migrationとWorkflow登録、全bindingの追加を行う。
5. secretsを注入し、`COLLECTOR_NODE_ENABLED=false`でVercel deploymentを作成する。GateのHTTPS入口、binding、鍵設定、DB schemaを確認する。
6. consumer／Cronは無効のまま、stagingの`COLLECTOR_NODE_ENABLED=true`を反映したdeploymentを作成する。署名付きNode APIとGate API、無署名の拒否を確認する。falseのままではNode handlerが認証前に503を返すため、双方向認証試験の合格とはしない。
7. 接続成功後にconsumerを有効化してstaging手動workを実行する。失敗時は受付停止を維持し、Nodeを無効化したdeploymentへ戻す。
8. staging受入を経て収集・保守Cronを有効化する。本番収集Cronは切替まで無効を維持し、本番のAPI有効化も新規受付停止中に確認する。

通常deployは、検証・bundle固定 → schema migration → Vercel deployment → Cloudflare Apply → secret保持／互換性確認 → 新規workのexecutor切替とする。初回作成と通常更新を別手順として文書化する。

## 検証計画

Terraformコードに対して、狭い意味のあるテストを実装と同時に追加する。mock providerによる設定検証と、stagingでの実資源検証を分ける。

```bash
terraform -chdir=infra fmt -check -recursive
terraform -chdir=infra/environments/collector-staging init -backend=false
terraform -chdir=infra/environments/collector-staging validate
terraform -chdir=infra/environments/collector-staging test
terraform -chdir=infra/environments/collector-production init -backend=false
terraform -chdir=infra/environments/collector-production validate
terraform -chdir=infra/environments/collector-production test
```

provider schemaも取得し、利用するresource・属性との対応を確認する。credential不要のinitでもprovider downloadにはネットワークが必要である。実Plan／ApplyはGitHub Actionsで行う。

受入項目:

- staging／productionの識別子・接続先・stateが分離される。
- 初回設定でCron・consumerが無効となる。
- Web project、既存DNS、外部管理のR2 bucketを変更しない。
- 永続資源に意図しないreplacement／destroyがない。
- 同一設定の再Applyで不要な差分がなく、secretが保持される。
- runtime secret値がstate、保存Plan、artifact、ログに混入しない。
- 保存Planを別commit／環境／bundleと組み合わせてApplyできない。
- 保存Planの暗号化・短期保持、未承認／許可ref外／検証失敗時のApply拒否をCI契約テストで確認する。
- WebとcollectorのPG migrationが同時実行されず、失敗時にdeployを停止する。
- Git pushではcollectorが自動deployされず、CLIによる固定deploymentのみが作成される。
- Workerの全binding、DO class／migration tag、Workflow定義、Gateの到達可能なHTTPS URLが一致する。
- bootstrap各phaseのPlanと、通常deploy時にphaseを戻す設定の拒否を確認する。
- 収集・保守Cronの集合に重複がなく、paused／drainで新規収集や再配送が再開されない。
- Gemini環境分離または共有Gateの設定がGoogle project単位のquota設計と一致する。
- unsigned、不正署名、期限切れ、nonce再利用では実処理を開始しない。
- queue再配送・API応答喪失時も保存結果を照会し、処理を重複公開しない。

runtimeコードを変更するPRでは、該当collector／domain／DBのVitest、format、lint、typecheckも実行する。Terraformだけの変更に対して不要なUI試験を追加しない。

## 権限・未確定事項

既存移行資料には、Actions tokenに新規資源の作成権限が不足しているという申告がある。現在の実権限は未確認であり、初回Plan／Apply前に棚卸し・必要な更新を行う。

| 項目 | 確定する段階 |
| --- | --- |
| collectorのstaging／production domain | PR 1 |
| Cloudflare account／zone、Vercel scope | PR 1 |
| Worker・Workflow・Queue・D1・DNS作成権限、Vercel project／deploy権限 | PR 1、初回Apply前 |
| R2 state／lock操作権限 | PR 1、初回Apply前 |
| 環境別DB接続先、TLS／pool設定 | staging連携前 |
| 固定providerのbootstrap・secret保持対応 | PR 1〜2 |
| runtime bundleとbinding／class契約 | PR 2 |
| Gate HTTPS入口、Git自動deploy停止方式、Deployment Protection | PR 1〜2、staging接続前 |
| GeminiのGoogle project分離／共有Gate方式 | PR 2前 |
| 復旧処理の周期・上限・mode別動作 | PR 2 |
| UTC Cron、並列数、Geminiクォータ設定 | staging受入前 |

token verifyやPlan成功だけで作成権限を保証しない。stagingで作成と再Applyを確認する。secret値は計画書やチャットへ記録しない。

## 本番切替と切り戻し

本番切替はTerraform実装の完成と別に実施する。既存移行計画の受入を満たし、旧Trigger scheduleを停止、実行中runの終了を確認してから新CronをTerraformで有効化する。旧基盤は切り戻し期間中保持する。

切り戻し時は新Cronを無効化し、controlをdrainにして新規処理とGemini許可を停止する。実行中処理と保存結果を照合した後、旧Trigger scheduleを再開する。D1／Queueをdestroyせず、追加DB migrationも残す。新旧基盤を同時に稼働させない。

ここで無効化する新Cronは収集Cronを指す。照合に必要な保守Cronは維持し、outbox／watchdogはdrainに従って新規配送・収集補完を行わない。新runtimeの書込み停止を確認できない場合は旧Triggerも再開せず、双方停止のまま障害対応する。

## 関連資料

- [ADR-0008: Cloudflareによるバッチ管理とVercelによる処理実行](adr/0008-cloudflare-control-vercel-execution.md)
- [移行実装計画](cloudflare-vercel-migration-implementation-plan.md)
- [バッチ移行計画](cloudflare-batch-migration-plan.md)
- [ローカル品質保証・Actions設計](cloudflare-vercel-local-quality-plan.md)
- [Terraform／Vercel／Cloudflare運用手順](terraform-vercel-cloudflare-runbook.md)
- [Cloudflare Secrets公式資料](https://developers.cloudflare.com/workers/configuration/secrets/)

本書作成時点ではMarkdown計画書のみを追加し、Terraformコード、実資源、migration、scheduleは変更していない。
