# Terraform による Vercel / Cloudflare DNS 運用手順書

更新日: 2026-10-10

この手順書は Upto Web のVercel project、GitHub連携、独自ドメイン、Cloudflareで管理しているVercel向けDNS recordと必要なTXT検証レコードをTerraform管理へ移すためのものです。Vercel projectはpnpm workspace内の`apps/web`をNext.jsとしてbuildし、GitHubへのpushでdeploymentを作成します。

## 管理対象と責務

| 対象 | 管理者 | Terraform resource |
| --- | --- | --- |
| Vercel Web project / GitHub連携 | Terraform | `vercel_project` |
| Vercel custom domain association | Terraform | `vercel_project_domain` |
| Cloudflare の Vercel DNS record | Terraform | `cloudflare_dns_record` |
| Vercel ownership verification TXT | Terraform（必要な場合のみ） | `cloudflare_dns_record` |
| Terraform remote state | Cloudflare R2 | S3 backend |

既存 Vercel project をTerraformへ移す場合は、先にprojectをimportします。Terraformはproject名、Next.js/pnpm workspace用のbuild設定、GitHub repository、production branch、domain associationを管理します。`DATABASE_URL`などのruntime secretはTerraform stateに保存せず、Vercel projectのsecret storeに残します。`environment`属性はignoreしているため、この構成が既存環境変数を削除・変更することはありません。新規projectではapply後、最初のGit pushより前にVercel dashboardでruntime secretを設定してください。

## collector移行時の追加要件

本書のZone Read / DNS Edit tokenはWeb/DNS運用向けである。**ユーザー申告として、現在のActions用トークンは移行先の新規リソース作成権限が不足しており、collector初回Plan / Apply前に更新・再発行とGitHub Environment Secretsの差し替えが必要。** Worker/DO、Workflow、Queue/consumer、D1、Vercel collector projectの作成・deploy・migrationに必要な権限を別途確認する。R2 credentialsは別管理で、新state keyとlock objectへの権限を確認する。

[ローカル品質保証・Actions設計](cloudflare-vercel-local-quality-plan.md)に全機能のローカルテスト、権限表、更新手順を定義する。collectorのPlan / ApplyはGitHub Actionsで行い、確認済みの保存PlanをEnvironment承認後に適用する。以下で説明する既存Web workflowはApply時に再計画する現行動作であり、collector移行時には保存Plan方式を実装する。collector専用workflowは末尾の「collector Terraform運用」に追加した。既存Web workflowと実トークンは変更していない。

## 事前準備

1. ローカルに Terraform 1.10 以上をインストールします。CI は 1.11.4 を使用します。
2. 別リポジトリで管理されている Cloudflare R2 state bucket、R2 S3 API token、および Access Key ID / Secret Access Key を準備します。このリポジトリは bucket を作成・削除しません。S3 API token は production state bucket だけに絞り、Object Read & Write 権限を付与します。
3. Cloudflare の通常運用 API token を作成します。対象 zone の **Zone: Read** と **DNS: Edit** のみを付けます。Global API Key は使いません。
4. Vercel の API token を作成します。対象team/projectを操作できるtokenに限定します。team projectの場合はTeam Settingsでteam IDも控えます。
5. VercelのGitHub integrationを対象repositoryへinstallします。TerraformがGitHub repositoryをprojectへ接続するには、このintegrationが必要です。
6. Vercel project名、GitHub repository名、Cloudflare account ID/zone ID、現在のVercel custom domainとCloudflare DNS record IDを控えます。Vercel向けDNS targetはTerraformが`vercel_domain_config`から取得するため、設定ファイルへ手入力しません。

Cloudflare が authoritative DNS の場合、TerraformはVercel domain associationの作成後に、Vercelが推奨するAまたはCNAME recordをCloudflareへ作成します。Vercel の TLS 発行・更新を妨げないよう、`proxied = false` を維持してください。

## 1. R2 backend を接続する

別リポジトリで管理された R2 bucket の S3 API credentials を次の環境変数へ設定します。Object Read & Write 権限には state の読み書きに加え、`*.tflock` lock object の作成・削除が含まれている必要があります。シェル履歴に値を残さず、password manager や CI secret store から注入してください。

```bash
export AWS_ACCESS_KEY_ID='<r2-access-key-id>'
export AWS_SECRET_ACCESS_KEY='<r2-secret-access-key>'
```

`infra/environments/production/backend.tf` は Git 管理し、R2 bucket、state key、Account IDを含むS3-compatible endpointなどの非secret設定を定義します。Access Key IDとSecret Access Keyは絶対にこのファイルへ書かず、ローカルではshell環境変数、CIではGitHub Environment Secretsから注入します。backend 内の `use_lockfile = true` により、同時実行時は R2 上のlock fileを使います。

## 2. Terraform input を確認する

production固有の非secret値は`infra/environments/production/variables.tf`のdefaultとしてGit管理する。`vercel_domains`にはFQDN、Cloudflare zone内のrecord名、record種別（`A`または`CNAME`）だけを指定する。Vercelが推奨するtargetは、domain associationを作成した後に`vercel_domain_config` data sourceから取得するため、手入力しない。

```hcl
default = {
  "www.example.com" = {
    record_name = "www"
    record_type = "CNAME"
  }
  # apex domainの場合
  # "example.com" = {
  #   record_name = "@"
  #   record_type = "A"
  # }
}
```

`verification_dns_records`は、VercelがTXT ownership verificationを要求する場合だけ追加する。challengeの値は初回apply後に判明する場合があるため、その場合はVercelが表示した値を追加して2回目のapplyを行う。

## 3. 既存リソースを import する

既存resourceがある状態で`apply`を先に実行すると、Terraformは作成を試みて失敗または不要な差分につながります。既存projectを使う場合はproject、各domain、DNS recordの順にimportします。Vercel projectがまだなければproject importはせず、planが作成するprojectとGit連携を確認してからapplyします。

```bash
terraform -chdir=infra/environments/production import \
  'module.vercel_project.vercel_project.web' \
  'team_xxx/prj_xxx'
```

personal account、またはproviderにteamを設定済みの場合のVercel project import IDは`prj_xxx`です。import後の最初のplanでは、Terraformが管理する設定（root directory、build command、GitHub repository、production branch）へのupdateが表示されることがあります。GitHub integrationと現在のproject設定を確認し、意図しない差分があればapplyしないで設定値を見直してください。

次にdomainとDNS recordをimportします。

```bash
terraform -chdir=infra/environments/production import \
  'module.vercel_domains.vercel_project_domain.custom["app.example.com"]' \
  'team_xxx/prj_xxx/app.example.com'

terraform -chdir=infra/environments/production import \
  'module.dns.cloudflare_dns_record.vercel["app.example.com"]' \
  '<cloudflare-zone-id>/<cloudflare-dns-record-id>'
```

personal account の Vercel domain import ID は `prj_xxx/app.example.com` です。Vercel domain が未登録なら import はせず、plan が作成する association を確認してから apply します。Vercel が要求した TXT record が既にある場合も、同様に `module.dns.cloudflare_dns_record.vercel_verification[...]` へ import します。

import 後は必ず差分を確認します。

```bash
terraform -chdir=infra/environments/production plan
```

DNS 削除、Vercelが推奨するtargetの変更、Vercel domain associationのreplacementが表示されたらapplyせず、Vercel domain設定と既存DNSを再確認してください。

## 4. GitHub Actions を設定する

GitHub repository に `terraform-production` environment を作成し、Required reviewers を設定します。production secrets は必ずこの environment にのみ保存します。

この environment に以下の **Secrets** を設定します。

| Secret | 値 |
| --- | --- |
| `TF_R2_ACCESS_KEY_ID` | R2 S3 API の Access Key ID |
| `TF_R2_SECRET_ACCESS_KEY` | R2 S3 API の Secret Access Key |
| `CLOUDFLARE_API_TOKEN` | Zone Read / DNS Edit の Cloudflare API token |
| `VERCEL_API_TOKEN` | 対象 Vercel project/team 用 API token |

workflow は次の動作をします。

1. `release-infra` 宛ての `infra/**` の PR では `fmt` と `validate` を実行します。
2. `release-infra` 宛ての同一repositoryからの pull request では、`terraform-production` environment approval の後に production plan を実行します。fork からの pull request は credential を使わず、fmt/validate のみ実行します。`release-infra` branch は pull request review と status check を必須に保護してください。
3. `release-infra` へ Terraform 変更を merge すると、production plan の成功後に apply を実行します。必要時は `release-infra` を選んで Actions の **Terraform** workflow を手動実行し、`plan` または `apply` を選べます。ほかの ref では credential を使う job は実行されません。apply は同じ production approval を要求します。

state と production apply が同時に走らないよう、apply job は GitHub Actions concurrency と Terraform S3 lock file の二重で保護されています。

## 5. 受入確認と切り戻し

1. GitHub Actions の plan が create/update/delete の意図どおりであることを確認します。
2. production applyを承認します。新規projectの場合は、続けてproduction branchへpushして初回production deploymentを開始します。
3. Cloudflare dashboardでA/CNAME/TXTがTerraform管理の値と一致し、Vercel向けA/CNAMEがDNS-onlyであることを確認します。
4. Vercel Project > Domains で domain が `Valid Configuration` になり、HTTPS が有効であることを確認します。
5. `release`へcommitをpushし、GitHub Actionsの`Release web` workflowがmigration後にVercel production deploymentを作成することを確認します。`test`へ`apps/web/**`、`packages/**`、またはworkspace依存設定を変更するcommitをpushし、Preview deploymentが作成されることを確認します。ほかのbranch、または対象外の変更だけの`test` commitではbuildが中止されることを確認します。
6. 実ドメインと `https://<domain>/api/articles?limit=1` を確認します。DB URL や token がresponse、Vercel log、Actions logに出ていないことも確認します。

問題時はまずActionsのapplyを止め、`terraform plan`でstateと実環境の差分を確認します。DNSをTerraform外で手修正してすぐにapplyするのは避けます。Vercelの直前deploymentへのrollbackはVercel dashboardで行えますが、DNS/domainを戻す場合は、このリポジトリの`variables.tf`を前の意図した値へ戻し、review済みのplanをapplyしてください。R2 state bucketとstate objectは削除しません。


## collector Terraform運用

更新日: 2026-10-11。Terraformコードと停止状態のbootstrap用Actionsを実装した。実Plan/Apply、作成権限、providerの再upload/secret保持、実URLの疎通はユーザーがActionsで検証する。ローカル合格をstaging受入の代替にしない。

### 管理範囲・provider確認

| 管理対象 | 固定providerの確認済み属性 |
| --- | --- |
| `vercel_project` | `root_directory`、`framework`、`node_version`、`install_command`、`build_command`、`environment` |
| `cloudflare_d1_database` | `account_id`、`name`、`id` |
| `cloudflare_queue` | `settings.message_retention_period`、`delivery_paused`、`delivery_delay` |
| `cloudflare_workers_script` | `content_file` / `content_sha256`、`main_module`、`compatibility_*`、`keep_bindings`、`migrations.new_sqlite_classes`、`observability`、`bindings` |
| `cloudflare_workflow` | `workflow_name`、`script_name`、`class_name` |
| `cloudflare_queue_consumer` | `queue_id`、`script_name`、`dead_letter_queue`、retry / batch / concurrency設定 |
| `cloudflare_workers_cron_trigger` | `schedules`（一つのresourceがscriptの全集合を所有） |
| `cloudflare_workers_script_subdomain` | `enabled`、`previews_enabled`。account subdomainの取得・作成はこのresourceでは行えない |

実際のCloudflare 5.24.0 / Vercel 5.14.0 schemaを取得し、`check-collector-schema.py` で利用属性を検査する。既存Webのprovider versionは更新しない。D1、Queue/DLQ、永続DOを持つWorker、Workflow、collector projectに `prevent_destroy` を設定した。Actionsはconsumerの停止用削除を除き、collector資源のdelete/replacementを拒否する。

固定schemaのAccepted Permissionsでは、script/Workflow/Cron/subdomainは `Workers Scripts Read` / `Workers Scripts Write`、D1は `D1 Read` / `D1 Write`、Queue/consumerは `Queues Read` / `Queues Write`（script権限も代替として列挙）、DNSは `DNS Read` / `DNS Write` が示されている。schemaの列挙はread/write全操作の許可を保証しない。対象account/zoneに限定して、初回Apply前にpermission groups APIの実ID、各endpointのCreate/Read/Update権限、token期限と担当者を運用台帳へ記録する。ログ照会用のTail権限は必要時に別確認し、推測でtokenを広域化しない。

collector projectは `apps/collector`、frameworkなし、Node 24、frozen install、`pnpm build:node`。projectをGit repositoryへ接続しない。さらに `apps/collector/vercel.json` の `git.deploymentEnabled=false` でGit自動deploymentを停止する。CLI deploymentはruntime工程で実施し、stagingでpushによる自動deploymentが発生しないことも確認する。[Vercel Git設定](https://vercel.com/docs/project-configuration/git-configuration)を参照。

projectの `environment` はignoreし、runtime環境変数はTerraformから登録しない。ビルド設定はprojectと `vercel.json` を同じ値にし、Function上限300秒と `NODEJS_HELPERS` は `vercel.json` が管理する。

### GitHub Environmentを準備する

環境ごとに一つ、合計二つのEnvironmentを作る。

- `terraform-collector-staging`
- `terraform-collector-production`

stagingは `staging` と `refs/pull/*/merge`、productionは `release-infra` のみ許可する。Required reviewersとPrevent self-reviewを設定し、PRコードへcredentialを渡す前に確認する。Plan/Applyは同じEnvironmentを参照する別job。stagingのApplyはworkflowとrelease scriptでマージ済みPRに限定し、forkはcredentialなしのvalidateのみ。承認待ちが表示されたjobをレビューし、Applyの承認待ちはPlan差分を確認してから承認する。Environment分割による独立の承認境界・Secret隔離はないため、PR内のworkflow/script変更もレビューする。

各Environmentへ次を一度ずつ登録する。

| 設定名 | 用途 |
| --- | --- |
| `TF_R2_ACCESS_KEY_ID` / `TF_R2_SECRET_ACCESS_KEY`（Secrets） | 対象stateと `.tflock` の読書き。bucket自体の管理権限は不要 |
| `CLOUDFLARE_API_TOKEN`（Secret） | account操作とDNS操作を兼ねる環境専用token |
| `VERCEL_API_TOKEN`（Secret） | 対象teamのproject/domain操作・環境変数の作成/更新・Functions deployment |
| `GEMINI_MODEL_PRIMARY`（Variable） | 新collectorの主モデル名。両Environmentで明示的に設定する |
| `GEMINI_MODEL_FALLBACK`（Variable） | 新collectorの代替モデル名。両Environmentで明示的に設定する |
| `COLLECTOR_CHUNK_CHARS`（Variable） | 本文チャンクの文字数。旧 `SUMMARY_CHUNK_CHARS` に対応し、`12000` を設定する |
| `GEMINI_API_KEY`（Secret） | 対象環境のGemini API key |
| `TF_PLAN_ENCRYPTION_CERT`（Secret） | Plan暗号化用RSA X.509 PEM公開証明書。Plan jobへ渡す |
| `TF_PLAN_DECRYPTION_KEY`（Secret） | 対応するRSA PEM秘密鍵。Apply jobへ渡す。repository/org共通Secretに置かない |
| `COLLECTOR_BOOTSTRAP_PROBE_KEY`（Secret、staging PoC時のみ） | 専用43〜128文字のbase64url鍵。runtime署名鍵を流用しない |

Geminiの3変数と `COLLECTOR_CHUNK_CHARS` はApply jobのFunctions deploy stepだけに注入する。`collector_deploy.py` が保存Planから確定したproject IDとownerを使い、deploy前に[Vercel環境変数API](https://vercel.com/docs/rest-api/projects/create-one-or-more-environment-variables)の `upsert=true` で登録・更新する。モデル名とチャンク長は `plain`、API keyは `sensitive` として登録する。stagingとproductionは別projectで、どちらもCLIの `--prod` deploymentなので登録先targetは各projectの `production` となる。Vercel側への手動登録や `.env` は不要。値の変更は次のApply/deploy時に反映される。GitHub Environmentへの初回設定は必要で、未設定・不正なモデル名・不正なチャンク長・API失敗・登録結果の不一致ではdeployを停止する。登録途中の失敗では既に更新済みの変数が残るため、原因を修正して通常のrelease工程を再実行する。

### 旧Trigger設定からの値の移行

2026-10-12に両GitHub Environmentへ主モデル・代替モデルとも `gemini-3.1-flash-lite`、チャンク長 `12000` を登録した。ユーザーの無料プランでFlashモデルを利用できないため、当面は両方に同じFlash-Liteモデルを指定する。新Node runtimeのprimary/fallbackは主モデルと代替モデルを表し、旧構成の通常/重要記事の振り分けとは異なる。

| 旧設定 | 新構成の登録先・扱い |
| --- | --- |
| `COLLECTOR_CONCURRENCY=1` | 両rootの `variables.tf` の `settings.default` に `max_concurrency`、`feed_concurrency`、`stage_concurrency`、`in_flight_limit` を `1` と明記 |
| `COLLECTOR_MAX_ITEMS_PER_FEED=3` | 同じ `settings.default.max_items_per_feed=3`。Workerの `COLLECTOR_CONFIG` に渡し、将来のFeedWorkflowでdiscovery requestの `maxItems` として使用する |
| `GEMINI_REQUESTS_PER_MINUTE=5` | 同じ `settings.default.gemini_rpm=5`。Workerの `COLLECTOR_CONFIG` に渡す。実際の分散Gate runtimeは未実装 |
| `GEMINI_RATE_LIMIT_MAX_RETRIES=2` | 新Node/domainは `apiAttempt` 最大3（初回＋追加2回）を実装済み。Queueの `max_retries` は別設定であり変更しない |
| `DEBUG=false` / `COLLECTOR_DRY_RUN=false` | 新Node runtimeにはこの環境変数がないため登録不要。実動作は `COLLECTOR_NODE_ENABLED` とCloudflareの制御modeで管理する |

ここでの設定保存はruntime起動を意味しない。bootstrapのpaused mode、Cron/consumer停止、Node disabledを維持し、実runtimeの受入後に切り替える。

API keyをコマンド引数、source archive、Terraform input/state、artifact、summaryへ保存しない。HTTPレスポンス本文も出力しない。その他のruntime変数（DB・署名鍵・version等）の自動登録は後続runtime release工程の対象である。

公開証明書と復号秘密鍵はjobごとのenv指定で渡し分けるが、共有Environmentにアクセスできるworkflowコードからは両方参照できる。

Cloudflareは `collector-staging` / `collector-production` の環境別tokenを用意し、各tokenにaccount操作とDNS操作をまとめる。Account → Workers Scripts: Edit、D1: Edit、Queues: Edit、Zone → DNS: Edit、Zone: Readを付与し、対象account/zoneを限定する。各環境のEnvironmentにはtokenを `CLOUDFLARE_API_TOKEN` Secretとして登録する。account資源とDNSは一つのdefault providerを共用し、同じ環境変数から認証して、認証用のTerraform変数は使わない。Vercel token、R2 credentialも環境変数からprovider/backendへ渡す。runtime secretをTerraform変数へ流用しない。同一account/zone内ではtokenの名前だけで環境別資源の権限は分離されない。

Plan証明書の秘密鍵は対象Environmentと管理者のsecret managerにだけ保管する。管理者がRSA鍵・証明書を生成して登録し、有効期限とローテーション担当を記録する。鍵更新時は旧保存Planを破棄し、新証明書で再Plan・再承認する。CLIで鍵の値を引数に渡さない。

Terraformの非secret値は各rootの `variables.tf` の `default` へ直接記入してGit管理する。Terraform input用のGitHub Variablesと設定JSONは不要（上記Geminiモデル名のVariablesはruntime deployment専用）。未確定の必須ID/domain/subdomainは `TODO` を実値に置換する。CIは反対側のvariables.tfのdomainも検査するため、staging初回Plan前に両環境の予約domainを記入する。personal accountのowner IDは `vercel_org_id.default`、staging試験の操作は `bootstrap_probe_action.default`、phaseは `settings.default.bootstrap_phase` に記入する。

CIは各variables.tfだけをbackend/providerなしの一時rootにコピーし、Terraform consoleでdefaultを評価する。TF_VARやtfvars、GitHub Variablesによるdefaultの上書きは取り込まない。CI内部の一時JSONは評価結果・bundle hash・保存Planの受け渡し用であり、利用者はvariables.tfだけを編集する。両variables.tfのhashを保存Planへ固定し、Apply時に対象commitのsourceと照合する。

project/Worker/Queue/D1/Workflow名はrootの固定環境名から生成する。domain、record名、account/zone、team、既存workers.dev subdomainは、初回Apply前に実値を確認する。domain association後に `vercel_domain_config` の推奨A/CNAMEを照会し、DNSは `proxied=false` にする。TXT ownership verificationは必要になった場合だけ `verification_dns_records` に追加する。既存DNSと同じrecord名を使わない。

非secret入力は `variables.tf` に列挙し、Actionsはallowlist外のfield、任意のbundle path/hash、runtime secret名を拒否する。`bundle_path` / SHA-256はCI自身が確定する。`settings` のCron、mode、上限値はmoduleで検証する。Geminiは環境別Google projectを用意する第一案で、共通Google project/共通Gateは未実装。共通projectを使う場合は接続契約を先に変更し、環境別DOだけでquotaが分離できるとは扱わない。

### 保存PlanとApply

1. stagingは同一repositoryの `staging` 向けPRでvalidateと参考Planを実行する。PR作成・更新・Ready for reviewが対象で、未マージのPRではApplyしない。
2. PRをマージすると `pull_request: closed` / `merged=true` で新runを起動し、`merge_commit_sha` をcheckoutして保存Planを作る。stagingへの直接push、マージせずcloseしたPR、stagingの手動dispatchはApply経路にしない。productionは `release-infra` の手動dispatchでoperationを選ぶ。
3. Plan jobは停止moduleを対象commitから配置し、SHA-256を記録する。bundle、provider lock、tfvars、release設定、保存Planをcommit/環境/root/state key/run ID/attempt/phaseのmanifestに結び付ける。phaseは `variables.tf` の `settings.default.bootstrap_phase`、probeは `bootstrap_probe_action.default` をPRで変更する。platform設定も同じvariables.tfから取得し、両環境のsource設定のhashを保存Planへ固定する。
4. raw Plan/stdout/stderr/JSONはprivate staging領域だけに保持し、公開summaryはresource addressと操作のみ。CMS/AES-256の `release.enc` だけをartifactへuploadし、1日保持する。
5. マージ後runでPlan成功後、Apply jobのEnvironment承認待ちが表示された場合は差分を確認して承認する。PR参考Planを再利用せず、同じマージ後runの暗号文hash、manifest、commit、環境、bundle、release設定、lockfileを照合して **`terraform apply <保存Plan>` だけ**を実行する。
6. PR参考PlanはPR番号別、マージ後runはstate別concurrencyで排他し、R2 lockも使う。stale Plan、欠損・期限切れ、不一致では失敗し、全jobの新attemptまたは修正PRで再Plan・再承認する。Applyだけのrerunは拒否する。
7. Applyと任意のprobe成功後、Vercel CLI `59.15.0` で同じcommitの追跡済みsourceをcollector projectへdeployする。project IDとteam IDは保存Plan/Apply出力を使う。personal accountではTerraform設定の `vercel_org_id.default` を使う。`--prod` は各環境専用projectのdomainへ反映し、`COLLECTOR_NODE_ENABLED=false` を明示する。復号Plan/state/CI生成の一時tfvarsはuploadせず（Git管理の非secret設定はsourceに含む）、CLIログも公開しない。PRのvalidateではNode 24とfrozen installでcollector test/typecheck/bundle importを確認する。実deploymentの停止応答は[staging検証手順書](collector-terraform-staging-verification.md)で確認する。PG/D1 migrationと業務runtime有効化はこの停止deployに含めない。
8. 成否にかかわらずprivate staging領域を削除する。不要な暗号化artifactは対象runのActions画面から削除できる。復号Plan/stateをPRやIssueへ添付しない。

途中失敗時はconsumer/Cron無効・pausedを維持する。Applyが途中まで進んだ場合も同じ保存Planを繰り返さず、stateと実資源を確認して新runで再Planする。前回成功phaseはstateの `bootstrap_phase` outputを参照し、失敗時はoutputだけで部分的作成の有無を判断しない。provider由来のraw errorは公開しない。401/403ではtoken scopeと権限を見直し、広域tokenへ自動fallbackしない。

### 初回bootstrap

| phase | 管理する資源・binding |
| --- | --- |
| `foundation`（既定） | Vercel project/domain/DNS、D1、記事Queue/DLQ。Queue配送停止。Worker/consumer/Cronなし |
| `worker` | 停止WorkerとSQLite DO namespace migration `v1`、D1/Queue/DO/JSON bindings、workers.dev有効化。Cron集合は空 |
| `workflows` | `FeedWorkflow` / `ArticleWorkflow`を既存Workerに登録。WorkerへのWorkflow bindingはまだ追加しない |
| `ready` | 両Workflow bindingsをWorkerに追加。consumerとCronは無効のまま |

両環境のphaseは `variables.tf` の `settings.default.bootstrap_phase` で指定する。stagingは一段ずつ変更するPRを作り、前段の完了後にマージしてPlan・承認・Applyする。旧release.jsonとGitHub Variablesは使わない。初回 `foundation` を省略せず、段階の巻き戻し・飛び越しをActionsで拒否する。Workflow名は決定済み文字列でbindingに設定し、Worker → Workflow登録 → 次Applyでbinding追加という順序で循環を解く。常用の `-target` は使わない。

| binding | resource / class |
| --- | --- |
| `CONTROL_DB` | 環境のD1 ID（制御状態のみ） |
| `ARTICLE_QUEUE` | 環境の記事Queue名 |
| `CAPACITY_GATE` | `CapacityGate`（SQLite DO） |
| `GEMINI_GATE` | `GeminiGate`（SQLite DO） |
| `FEED_WORKFLOW` | `upto-collector-<環境>-feed` / `FeedWorkflow` |
| `ARTICLE_WORKFLOW` | `upto-collector-<環境>-article` / `ArticleWorkflow` |
| `COLLECTOR_CONFIG` | 環境、mode、origin、Cron、並列数、Gemini project/budget、保守処理の上限を含むJSON |

class名、namespace、migration tagを変更すると永続DOに影響するため、安易な変更と `v1` の別用途への再利用をしない。追加class migrationが必要なら、新tagと既存tagを使う変更を別途レビューし、backup/復旧可能性を確認してから適用する。

### Staging secret保持PoC

`keep_bindings=["secret_text"]` のschema確認だけではsecret保持は証明できない。[Cloudflare Secrets](https://developers.cloudflare.com/workers/configuration/secrets/) の各サービスsecret storeへ注入し、以下の実確認を行う。

1. stagingのTerraform設定を `settings.bootstrap_phase=worker` / `bootstrap_probe_action=inject` とするPRをマージし、保存Planを承認する。Environmentの専用probe鍵を、Cloudflare [Worker secret API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/secrets/methods/update/) へ注入する。鍵をTerraformに渡さない。
2. stopped Workerの `GET /__bootstrap/secret-retention` へランダムchallengeのHMAC付きrequestを送り、responseの別方向HMACを照合する。API read-back・保存Plan JSON・stateに鍵の値がないことも検査する。この入口はprobeだけで、記事処理・DB書込み・Gemini許可を行わない。collector本体のHMAC/nonce認証の代替ではない。
3. `workflows` phaseをApplyし、次にTerraform設定を `settings.bootstrap_phase=ready` / `bootstrap_probe_action=verify` とするPRをマージする。このrunのPlanにWorker updateがあることを必須にし、再upload後に同じ鍵のproof・binding保持・state非混入を確認する。verifyは鍵を再注入しない。
4. readyのphaseを維持してbootstrap_probe_actionだけnoneへ変えたPRで、不要なresource差分がないことを確認する。マージ後のno-op保存PlanもApplyする。secret保持・migration tag・全binding・Workflow登録・Gate HTTPS originの証拠を運用台帳へ記録する。account subdomainやサービス側の伝播待ちによる失敗は、原因を確認して新runで再試行する。
5. 保持できない、read-backに値が入る、余分な再uploadが続く場合は起動を停止したままdeploy方式を再検討する。PoC鍵はstaging専用とし、実runtimeへ置換する時にsecret storeから削除する。

### Backup・復旧・後続runtimeとの接続

D1のtable migration・business dataはTerraform管理外。実table作成後はTime Travelの利用可否と保持範囲を環境で確認し、migration/切替前にD1のexportをアクセス制限付きstorageへ保存する。復旧はconsumer/Cron停止、D1 snapshot/Time Travel復元、整合照合、必要なQueue再配送の順に実施し、D1をdestroyして作り直さない。

DO namespaceはSQLite永続状態を保持する。Terraform state/R2 backupだけではDOの業務データは復旧できない。本runtimeにexport/restoreと再構築手順を実装し、容量lease・Gemini permitのfencingと未確定送信を照合してから再開する。現時点のDOは停止classのみで業務データを持たない。実データのbackup/restore演習が通るまで新runtimeの起動を認めない。

本runtimeとD1 repositoryが完成した後に、以下を別release工程で接続する。現在のbootstrap workflowは `runtime_verified=true`、paused以外のmode、consumer/Cronを拒否するため、設定値だけで本番処理を開始できない。

1. 全検証と本Worker bundleを固定し、API/config/executor versionもrelease manifestへ記録する。
2. PG/D1 migration → Vercel固定deployment → Worker保存Plan/Apply → secret保持/接続検証 → 新workのexecutor切替の順にする。migrationが失敗したら以後のdeploymentを実行しない。初回はD1 foundation作成後にmigrationし、停止Workerで接続を確認する。
3. PG migrationはWebと共有するjob concurrency `postgres-production-migration` を両workflowのmigration jobに設定する。Webのworkflow全体 `production-release` と別名にして循環待ちを避ける。**現在はcollectorのmigration jobがないため、両workflow共通の排他は未実装であり、runtime release追加時にWeb側も変更する。** このTerraform workflowはPG/D1 migrationを実行しない。
4. Geminiのモデル名とAPI keyは既存のFunctions deploy stepが自動登録する。その他の各version、`COLLECTOR_GATE_ORIGIN`、key ID、DB pool上限も後続runtime release工程でCIから設定する。変数の正式名は `apps/collector/.env.example` に従う。`DATABASE_URL`、CA、署名鍵、cursor鍵、Gate鍵もVercel secret storeへ注入する。Cloudflare runtime鍵名は本runtime契約で確定する。
5. stagingのNode有効deploymentで双方向の署名付きAPI、未署名拒否、Deployment Protection/automation bypassを検証する。旧deploymentを進行中workの参照がなくなるまで保持する。redirectに署名を無条件転送しない。
6. 収集Cronと保守Cronは同じscriptの集合として一元管理する。収集slotはUTCで明示し、保守Cronは5分周期を第一案とする。outbox、reconciler、cleanup、watchdogの振り分け・slot冪等性・上限・paused/drain動作は本runtimeで実装する。
7. 欠落slot、outbox滞留、期限切れlease、DLQ、Gemini予算不足は本runtimeのstructured logと通知に接続する。Terraformはobservabilityを有効にするが、監視・通知の実装完了を意味しない。担当者・通知先・対応手順をruntime受入時に記録する。

本番切替はADR-0008採用と移行全体の受入後に行う。旧Trigger schedule停止・実行終了確認後に新Cronを有効化する。切り戻しでは収集Cronを停止しdrainへ移行、照合用保守Cronを維持する。D1/Queue/DOや追加PG migrationを削除せず、新旧同時実行を避ける。
