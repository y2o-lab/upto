# Collector Terraform staging検証手順

作成日: 2026-10-12

## 目的と完了時の状態

GitHub Actionsの `Collector Terraform` を使い、stagingの基盤作成、WorkerとWorkflowの登録順序、secret保持、同じ設定の再Applyを確認する。

完了時は `bootstrap_phase=ready`、`control_mode=paused`、consumer無効、収集・保守Cronなしとする。配置するWorkerは停止bundleであり、記事取得、Gemini送信、PostgreSQLへの保存は実行しない。Vercel Functionsは同じマージcommitからActionsでdeployし、`COLLECTOR_NODE_ENABLED=false`で受付停止にする。PG/D1のtable migration、collector本runtimeの受入は後続作業である。現行Trigger.dev運用は継続する。

Terraformの管理方針は [Terraform運用手順](terraform-vercel-cloudflare-runbook.md#collector-terraform運用)、検証対象の設計は [実装計画](collector-terraform-implementation-plan.md) を参照する。

## 1. 実行前の準備

### 1.1 コードとworkflowをGitHubへ反映する

stagingのPlan／Applyは **`staging` をbaseにした同一repositoryのPR** で実行する。PR作成・更新時は確認用Plan、PRのマージ時はマージcommitで新しい保存Planを作り、Environment承認後にApplyする。マージせず閉じたPR、stagingへの直接push、stagingの手動dispatchではApplyしない。fork PRはcredentialなしのvalidateのみで、適用が必要な変更はmaintainerの同一repositoryブランチからPRを作る。

実装の未commit／未pushの変更はActionsから実行できない。Environment SecretsとTerraform設定を先に用意し、作業ブランチの実装をレビュー対象のPRとして `staging` へ向ける。初回はこのPRを `foundation` のままマージする。[GitHubのPRマージイベント](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#running-your-pull_request-workflow-when-a-pull_request-merges)を使用し、stagingの実行にRun workflowやdefault branchへの手動dispatch登録は不要。

stagingはPR必須で保護し、対象PRのvalidateとPlanの成功を確認してマージする。各段階のApply／probeが完了するまで次のphaseのPRをマージしない。本手順ではcommit、push、PR作成、mergeを自動実行しない。

### 1.2 非secret値と既存資源を確認する

| 項目 | 確認内容 |
| --- | --- |
| Cloudflare account ID | staging Worker、D1、Queue、Workflowを作成するaccount。32桁の小文字16進数 |
| Cloudflare zone ID | collectorドメインを管理するzone。32桁の小文字16進数 |
| Vercel team ID | collector projectを作成するteam。personal accountの場合だけ空文字で指定可 |
| stagingドメイン | 例: `collector-staging.example.com`。既存Web・production collectorと別hostname |
| DNS record名 | zoneが `example.com` なら例は `collector-staging`。FQDNとzoneの組み合わせが合うこと |
| production用の予約ドメイン | 例: `collector.example.com`。未作成でも、stagingと異なる予定hostnameを決める |
| workers.dev subdomain | 既存accountのsubdomain部分。`example-account.workers.dev` なら `example-account`。Terraformではaccount subdomainを作成・変更しない |
| R2 backend | `infra/environments/collector-staging/backend.tf` のbucketとendpointが使用する既存backendであること |

次の資源名が別用途で使われていないことを各サービスの管理画面で確認する。既存Webの資源や他stateの資源をstagingへimportしない。同名の資源が既にある場合は、作成元と所有stateを確認してから進める。

| サービス | 作成予定名 |
| --- | --- |
| Vercel project | `upto-collector-staging` |
| Cloudflare D1 | `upto-collector-staging-control` |
| Cloudflare記事Queue | `upto-collector-staging-articles` |
| Cloudflare DLQ | `upto-collector-staging-dlq` |
| Cloudflare Worker | `upto-collector-staging-control` |
| Feed Workflow | `upto-collector-staging-feed` |
| Article Workflow | `upto-collector-staging-article` |

state keyは `collector-staging/terraform.tfstate`、lock objectは `collector-staging/terraform.tfstate.tflock`。既存Webの `web-production/terraform.tfstate` とproduction collectorのstateを使わない。R2 bucket自体は作成・変更しない。

この停止基盤の試験にはDB接続文字列、Gemini API key、本collectorの署名鍵は不要。Google projectの分離は本runtime接続前に確定する。

### 1.3 操作権限を準備する

対象account／zone／teamを限定したtokenを用意する。既存のWeb用tokenでcollector資源の新規作成ができるとは仮定しない。

| credential | 必要な操作 |
| --- | --- |
| Cloudflare collector token | Worker upload/settings/subdomain/Cron、SQLite DO migration、Workflow登録、Queue/D1作成、Worker secret注入・settings読出し、対象zoneのDNS照会・A/CNAME/TXT作成 |
| Vercel token | 対象teamでのproject/domain作成、domain config照会、Functions deployment |
| R2 credentials | stagingのstate／lock objectの読書き・lock削除 |

必要権限の名称と固定providerの確認結果は [運用手順の権限説明](terraform-vercel-cloudflare-runbook.md#管理範囲provider確認) を参照する。tokenの有効期限、対象scope、担当者を非secretの運用台帳へ記録する。token値をMarkdownやtfvarsへ記録しない。

## 2. GitHub Environmentと鍵を設定する

### 2.1 環境ごとに一つのEnvironmentを作る

リポジトリの Settings → Environments で次を作成する。Plan/Applyは同じEnvironmentを使う。

| Environment | 設定 |
| --- | --- |
| `terraform-collector-staging` | Selected branchesで `staging` と `refs/pull/*/merge` を許可。Required reviewers、Prevent self-reviewを設定 |
| `terraform-collector-production` | `release-infra` のみ許可。Required reviewers、Prevent self-reviewを設定 |

実行者とは別の承認者を用意する。PRコードへcredentialを渡す前にEnvironmentのレビューを行う。stagingはEnvironmentでPR refも許可するため、Apply制限はworkflowとrelease scriptのマージ条件で行う。PlanとApplyは別jobで、ApplyはPlan成功後に同じrunの保存Planだけを使う。承認待ちが表示されたjobをレビューし、Applyの承認待ちはPlan差分を確認してから承認する。Environmentを分けた独立の承認境界・Secret隔離はない。

Required reviewersやEnvironment Secretの利用可否はGitHubの契約・リポジトリ公開範囲に依存する。[GitHub Environmentの条件](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)を参照。

Cloudflare tokenは `collector-staging` / `collector-production` の2本を用意し、各tokenに Account → Workers Scripts: Edit、D1: Edit、Queues: Edit と Zone → DNS: Edit、Zone: Read を付与する。対象accountと対象zoneを限定し、対応するEnvironmentへSecret名 `CLOUDFLARE_API_TOKEN` で一度登録する。同一account/zone内の資源への権限はtoken名だけでは分離されない。

### 2.2 Plan暗号化鍵とprobe鍵を用意する

管理者の端末で、リポジトリ外の専用一時ディレクトリに鍵を生成する。以下は生成用の例であり、手順書作成時には実行していない。

```sh
umask 077
staging_secret_dir="$(mktemp -d "${TMPDIR:-/tmp}/upto-staging-secrets.XXXXXX")"

openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 \
  -subj '/CN=upto-collector-staging-plan' \
  -keyout "$staging_secret_dir/plan-decryption.key" \
  -out "$staging_secret_dir/plan-encryption.crt"

python3 - "$staging_secret_dir/bootstrap-probe.key" <<'PY'
import secrets
import sys
from pathlib import Path

Path(sys.argv[1]).write_text(secrets.token_urlsafe(32))
PY
```

鍵の値をターミナルへ表示する必要はない。ファイルからsecret管理ツールまたはGitHubのSecret入力欄へ登録する。公開証明書は秘密鍵と対応するものを使用し、probe鍵は別の専用鍵とする。

秘密鍵・probe鍵をsecret managerへ保管し、証明書の期限と担当者を記録する。登録・保管を確認した後、一時ファイルを削除する。下記は生成直後と同じshellで、変数が自分の専用一時ディレクトリを指すことを確認してから実行する。

```sh
rm -f -- "$staging_secret_dir/plan-decryption.key" \
  "$staging_secret_dir/plan-encryption.crt" \
  "$staging_secret_dir/bootstrap-probe.key"
rmdir -- "$staging_secret_dir"
unset staging_secret_dir
```

### 2.3 Secretsを登録する

`terraform-collector-staging` に以下を一度ずつ登録する。workflowはPlanに公開証明書、Applyに復号秘密鍵を渡すが、Environmentにアクセスできるworkflowコードからはどちらも参照できるため、同一repositoryのPRも承認前にコードをレビューする。

| Secret名 | 入力元 |
| --- | --- |
| `TF_R2_ACCESS_KEY_ID` | R2のAccess Key ID |
| `TF_R2_SECRET_ACCESS_KEY` | R2のSecret Access Key |
| `CLOUDFLARE_API_TOKEN` | stagingのaccount・zone操作を兼ねるcollector専用token |
| `VERCEL_API_TOKEN` | Vercel token |
| `TF_PLAN_ENCRYPTION_CERT` | `plan-encryption.crt` のPEM全文 |
| `TF_PLAN_DECRYPTION_KEY` | `plan-decryption.key` のPEM全文 |
| `COLLECTOR_BOOTSTRAP_PROBE_KEY` | `bootstrap-probe.key` の値 |

復号秘密鍵はrepository/org共通Secretへ置かない。probe鍵は43〜128文字のbase64url文字列で、この例では43文字となる。`inject` から `verify` が完了するまで同じprobe鍵を維持する。本runtimeの鍵を流用しない。

### 2.4 非secret値をvariables.tfのdefaultへ記入する

GitHub Environment Variablesや設定JSONの登録は不要。各環境のTerraformファイルを編集してPRへ含める。

- staging: `infra/environments/collector-staging/variables.tf`
- production: `infra/environments/collector-production/variables.tf`

各variableの `default` に具体的な値を直接記入する。未確定の必須ID・hostnameは `TODO` なので、初回Plan前に実値へ置換する。例（既存の型・validationを維持してdefaultだけ変更する）:

```hcl
variable "cloudflare_account_id" {
  type    = string
  default = "<staging account ID>"
}

variable "collector_domain" {
  type    = string
  default = "collector-staging.example.com"
}
```

`cloudflare_zone_id`、`vercel_team_id`、`workers_dev_subdomain` も同様に記入する。`dns_record_name` はstagingが `collector-staging`、productionが `collector` を初期値としているため、選んだhostnameに合わせる。

`example.com` や山括弧内は例示用。両環境の `collector_domain.default` を別hostnameで先に記入する。CIは反対側のvariables.tfからdomainを取得して衝突を検査するため、staging初回Planでもproductionの予約domainは必要。productionの他の未確定IDまで埋める必要はない。

team利用では `vercel_team_id.default` を設定し、`vercel_org_id.default` は空文字。personal accountでは逆にteamを空文字にし、`vercel_org_id.default` にowner IDを記入する。project IDはApply出力を使用する。`workers_dev_subdomain` に `https://` や `.workers.dev` を含めない。

bootstrap段階は `variable "settings"` のdefault内の `bootstrap_phase`、stagingのsecret保持試験は `variable "bootstrap_probe_action"` のdefaultで変更する。起動設定はpaused、consumer無効、Cronなしを維持する。

CIはvariables.tfだけをbackend/providerなしの一時rootへコピーし、Terraform consoleでdefaultを評価する。GitHub Variables、TF_VAR、ローカルtfvarsから上書きしない。評価結果からCI内部の一時tfvars/manifestを生成するが、利用者が編集するJSON設定はない。両環境のvariables.tfも暗号化Planのmanifestに含め、Apply時にcheckoutしたファイルhashと照合する。

API token、DB URLなどのsecretはdefaultへ書かない。`bundle_path` / `bundle_sha256` は空文字のままにし、CIが計算する。旧 `configuration.auto.tfvars.json` / `release.json` は廃止した。旧GitHub Variables `COLLECTOR_TF_CONFIG` / `COLLECTOR_PEER_DOMAIN` / `VERCEL_ORG_ID` は参照しないので削除できる。

## 3. PRとマージ後のActions共通操作

1. 同一repositoryの作業ブランチから、baseを **`staging`** にしたPRを作成する。Draft PRはvalidateのみで、PlanはReady for review後に実行される。
2. PRのChecksから **Collector Terraform** を開き、必要なPlan jobのEnvironment承認を行う。
3. validate／Planの成功、Summaryの環境 `staging`、phase、resource address・操作を確認する。このrunではApply jobがskipされることを確認する。
4. 既存Web、production collector、R2 bucketへの変更、永続資源のdelete/replacementがあればマージしない。
5. PRを `staging` へマージする。`closed` + `merged=true` のイベントで新しいrunが起動する。
6. 新runのvalidateとPlanを確認する。checkout／保存Planのcommitは当該PRの `merge_commit_sha`。PR時の参考PlanをApplyへ流用しない。
7. Plan成功後、Apply jobがEnvironment承認待ちの場合は差分を確認して承認する。暗号化artifactの1日保持期限内に完了させる。
8. Apply、指定した場合はprobe、続く **Deploy stopped collector Functions from the applied commit** の成功を確認する。Summaryのdeployment URLとcommit、PR URL／各run URL／phase／確認結果を記録する。Functions deployはApply/probe失敗時に実行しない。

stagingの手動入力 `environment`／`operation`／`bootstrap_probe_action` は使わない。probe操作は保存Planに同梱されたTerraform設定から取得し、Apply時にもマージcommitのファイルhashと照合する。productionの手動経路は `release-infra` の `workflow_dispatch` として別に維持される。

PRの確認用PlanはPR番号別のconcurrency、マージ後のrunはstaging state単位のconcurrencyで排他する。PR Planの承認待ちがマージ後のrunを同じActions lockで塞がないよう分ける。R2 lockは両経路で使う。マージ後の前runが承認待ちの場合は完了または不要runのキャンセル後に進める。

## 4. 四段階のbootstrapを試す

各行はstagingの `variables.tf` の変更をレビューして `staging` へマージする単位。初回だけは現在の実装PRに `foundation` / `none` を含める。

| 順序 | `bootstrap_phase` | `bootstrap_probe_action` | PR時 | マージ後 |
| --- | --- | --- | --- | --- |
| 1 | `foundation` | `none` | 初回Plan・環境分離を確認 | Vercel/DNS、D1、Queue/DLQをApply |
| 2 | `worker` | `inject` | 停止Worker/DO追加を確認 | Apply後に専用secretを注入してproof確認 |
| 3 | `workflows` | `none` | Workflow登録を確認 | 二つのWorkflowを既存Workerへ登録 |
| 4 | `ready` | `verify` | Worker updateとbinding追加を確認 | 再upload後のsecret保持を確認 |
| 5 | `ready` | `none` | probeだけnoneへ変更したPRでno-drift確認 | no-op保存Planを再Applyして停止状態を確認 |

### 4.1 foundation

設定は最初の `foundation` / `none` のまま、staging向けPRで確認用Planを実行する。対象はstagingのproject/domain/DNS、D1、二つのQueueと補助的な `terraform_data`。Worker、Workflow、consumer、Cronはまだ作成しない。

問題がなければPRをマージし、マージ後のPlanを確認してApplyを承認する。各サービスの管理画面で以下を確認する。

- Vercelに `upto-collector-staging` があり、Root Directoryが `apps/collector`、Nodeが `24.x`、Git repository未接続である。
- 指定domainがprojectに関連付けられ、Cloudflare DNSはVercelの推奨targetかつDNS only（`proxied=false`）である。
- D1と記事Queue/DLQが作成され、Queue配送停止、consumerなしである。
- R2のstaging stateが作成され、既存Web／production stateを使っていない。

各phaseのApply/probe成功後、Vercel CLI `59.15.0` がcollector projectのproduction targetへコードをdeployする。staging専用projectなので、`--prod` はstaging domainへの反映を意味する。Terraform/DNSのno-opでもFunctions deployは実行する。

Actionsは `git archive <merge_commit_sha>` の追跡済みsourceだけを一時ディレクトリに展開し、monorepo rootからuploadする。復号Plan/state/CI生成の一時tfvars、runnerのローカル `.env`、生成bundleはuploadしない。Git管理のvariables.tfは追跡済みsourceに含まれる。Vercel側はprojectのRoot Directory `apps/collector` と固定lockfileでbuildする。PRのローカルbundle検証はplatform buildの代替ではない。[Vercel CLI deploy](https://vercel.com/docs/cli/deploy)のruntime env指定で `COLLECTOR_NODE_ENABLED=false`、`COLLECTOR_ENVIRONMENT=staging` を固定する。

deploymentがReadyとなり、九つの `/api/v1/*` Functionsが配置されたこと、deployment metadataの `collectorCommit` がマージcommitと一致することを確認する。Summaryのdeployment URLとcustom domainの両方へ `POST /api/v1/prepare` を送り、503とJSONの `errorCode: NODE_EXECUTION_DISABLED` を確認する。例:

```sh
curl --silent --show-error --include --request POST \
  https://collector-staging.example.com/api/v1/prepare
```

Deployment Protectionがある場合は許可された認証済みブラウザ／検証経路を使う。Protectionの401/403やHTMLをFunctionsの停止応答と混同しない。DB/Gemini/authのruntime secretはこの停止確認に不要。TLS/DNS反映前はdeployment URLで先に確認し、custom domainも反映後に確認する。

ownership verificationのTXTが要求された場合は、Vercelの提示する公開challengeに従いJSONへ `verification_dns_records` を追加し、**foundationのまま**確認用Planを更新して差分をレビューする。まだPRが未マージなら同じPRを更新し、すでにApply済みなら新PRで変更を記録してマージ後のPlan／Applyを行う。次は形式例で、name/contentはVercelの指示へ置換する。

```json
"verification_dns_records": {
  "staging-ownership": {
    "name": "_vercel.collector-staging",
    "content": "VERCEL_PUBLIC_VERIFICATION_CHALLENGE",
    "ttl": 1
  }
}
```

既存Web用のTXTを上書きしない。challenge未確定のまま例の値をApplyしない。

### 4.2 workerとsecret注入

設定の `settings.bootstrap_phase` を `worker`、`bootstrap_probe_action` を `inject` に変更したPRを `staging` へ向ける。PR Planを確認してマージし、マージ後の保存Planを承認する。Planでは停止Worker、workers.dev公開設定、空のCron集合の追加が主な差分となる。DOはWorkerのSQLite migration `v1` で作成し、独立したinstance resourceは作成しない。

承認後、Applyだけでなく **Optional staging secret retention PoC** の成功まで確認する。Summaryに `Staging bootstrap secret PoC: inject succeeded` を含む結果が出ることを確認する。これは専用鍵でのHTTPS proof、binding存在、probe鍵がAPI read-back・保存Plan JSON・stateへ混入していないことの検査である。

Workerは `upto-collector-staging-control`。基本bindingsは `CONTROL_DB`、`ARTICLE_QUEUE`、`CAPACITY_GATE`、`GEMINI_GATE`、`COLLECTOR_CONFIG`。DO classは `CapacityGate` と `GeminiGate`、Workflow bindingsはまだない。Cronは空、Queue consumerもないことを確認する。

署名なしの通常入口は停止状態の503が期待値。以下は鍵を送らない任意の疎通確認例であり、TLS・到達性の確認に限定する。

```sh
curl --silent --show-error --output /dev/null --write-out '%{http_code}\n' \
  'https://upto-collector-staging-control.<実際のsubdomain>.workers.dev/'
```

`--insecure` やredirect追従を追加しない。ルートの503だけではsecret保持PoCの合格とはしない。

### 4.3 workflows

設定の `settings.bootstrap_phase` を `workflows`、`bootstrap_probe_action` を `none` に変更したPRを `staging` へ向ける。前段のApply／inject成功後に、PR Planを確認してマージし、保存Planを承認する。

`upto-collector-staging-feed` / `FeedWorkflow`、`upto-collector-staging-article` / `ArticleWorkflow` が、同じstaging Workerへ登録されることを確認する。WorkerへWorkflow bindingsを追加するのは次の段階。試験用Workflow instanceを手動起動する必要はない。

### 4.4 readyと再upload後のsecret保持

設定の `settings.bootstrap_phase` を `ready`、`bootstrap_probe_action` を `verify` に変更したPRを `staging` へ向け、前段の成功後にマージする。

Planにstaging Workerの **update** があり、Workflow bindings追加に対応することを確認して承認する。`verify` は鍵を再注入せず、再upload後の同じ鍵によるproofと値の非混入を確認する。Summaryに `Staging bootstrap secret PoC: verify succeeded` を含む結果が出ることを確認する。

最終的なbindingは次のとおり。識別子はstagingの資源に対応していることを管理画面で確認する。

| binding | 対応先 |
| --- | --- |
| `CONTROL_DB` | `upto-collector-staging-control` のD1 ID |
| `ARTICLE_QUEUE` | `upto-collector-staging-articles` |
| `CAPACITY_GATE` | SQLite DO `CapacityGate` |
| `GEMINI_GATE` | SQLite DO `GeminiGate` |
| `FEED_WORKFLOW` | `upto-collector-staging-feed` / `FeedWorkflow` |
| `ARTICLE_WORKFLOW` | `upto-collector-staging-article` / `ArticleWorkflow` |
| `COLLECTOR_CONFIG` | environmentが `staging`、modeが `paused`、originが指定collector domain |

PoC専用の `COLLECTOR_BOOTSTRAP_PROBE_KEY` もsecret bindingとして存在する。鍵の値を管理画面や記録に表示しない。

### 4.5 no-driftと再Apply

設定の `settings.bootstrap_phase` は `ready` を維持し、probeだけ `none` に変更したPRを `staging` へ向ける。bundleやplatform設定は変えず、PR Planを確認する。Summaryの `No resource changes.` を確認する。resource差分が出た場合は、providerのread-back、secret保持、migration、binding設定のどれに起因するか確認し、合格として先へ進めない。

次にそのPRをマージし、マージ後も差分がない保存Planを確認してApplyを承認する。再Apply後もCronなし、consumerなし、Queue配送停止、secret bindingが存在することを確認する。

**no-op Planに `bootstrap_probe_action=verify` を使わない。** verifyはWorker updateを必須とするため、不要な差分のない正常なPlanでもprobe段階で失敗する。再upload後の値保持は前段のreadyへの移行で確認する。

## 5. 合格記録

以下を確認した後、stagingの基盤検証を完了とする。記録は非secret情報に限定する。

- [ ] 四段階のApplyが成功し、phaseを飛ばさず `ready` へ進んだ。
- [ ] Vercel/DNS・D1・Queue/DLQ・Worker・Workflow・SQLite DO設定がstagingに対応している。
- [ ] ActionsからのFunctions deploymentがReadyで、commit一致とdeployment URL／custom domainの停止応答（503 / NODE_EXECUTION_DISABLED）を確認した。
- [ ] `inject` と、Worker update後の `verify` の両方が成功した。
- [ ] 同じready設定のPlanでresource差分がなく、再Applyにも成功した。
- [ ] Cronなし、consumerなし、Queue配送停止、`control_mode=paused` を維持している。
- [ ] 既存Web、production、外部管理のR2 bucket、現行Trigger scheduleに変更がない。
- [ ] artifactは暗号化ファイルだけで、鍵・raw state/Plan・復号JSONを記録へ添付していない。

記録用テンプレート:

```markdown
## Collector staging Terraform検証結果

- 実施日:
- 実行者 / 承認者:
- 対象commit SHA:
- staging collector domain / Gate origin:
- foundation PR / 参考Plan / マージ後run URL:
- worker PR / inject run URL:
- workflows PR / run URL:
- ready PR / verify run URL:
- no-drift PR / 参考Plan / 再Apply run URL:
- state key: collector-staging/terraform.tfstate
- binding / DO migration v1 / Workflow登録の確認結果:
- secret PoC / 非混入検査の結果（値は記載しない）:
- Cron / consumer / Queue / paused状態の確認結果:
- 既存Web / production / Triggerへの影響:
- 未解決事項:
```

この合格は停止基盤とprobe鍵についての証拠であり、本collectorの署名・nonce処理、D1 repository、Gemini quota、記事保存、起動したVercel runtimeの受入完了を意味しない。

## 6. 失敗した場合

| 状況 | 対応 |
| --- | --- |
| stagingのrunが起動しない | PRのbaseがstagingか、対象pathsに変更があるか、workflowがPRのコードに含まれるか確認。手動Run workflowは使わない |
| Plan/Applyがskipされた | 同一repositoryのstaging向けPRか確認。DraftはPlanなし、未マージはApplyなし、forkはvalidateのみ。マージせずcloseしたPRでもApplyしない |
| Applyが承認待ちにならない | 共有EnvironmentのRequired reviewersとjobの承認状態を確認。独立したApply専用Environmentは使わない |
| `validate` 失敗 | backend/API非接続の検証ログを確認。コードを修正し、対象commitを揃えてから新runを実行 |
| Functions deploy失敗 | Apply済み資源は戻さない。Vercel側のbuild診断、token deployment権限、保存Planのteam/personal owner設定を確認し、修正PRかrun全jobの再実行で再Plan・承認する。deployだけを目的にApply jobを単独rerunしない |
| configuration / bootstrapエラー | variables.tf、必須ID/hostname、paused設定、前回成功phaseを確認。phaseを飛ばしたり戻したりしない |
| `Terraform init/plan/apply failed` | 該当段階、token期限/scope、R2 state/lock権限、各サービスのaudit logや資源状態を確認。秘密値を含むraw errorを公開しない |
| decrypt / hash / artifact不一致 | 公開証明書と秘密鍵の組、run/commit/環境、artifact期限を確認。古いPlanを再利用せず、マージ後runの全job再実行または修正PRのマージで再Plan・再承認 |
| stale Plan | 最新stateで新しいPlanを作成し、再承認。再計画する `apply -auto-approve` へ切り替えない |
| 別runが待機している | 前のstaging runの承認待ち・実行状態を確認し、完了または不要なrunのキャンセルを行う |
| Applyは成功、probeだけ失敗 | Apply済みのphaseと実資源を維持して、鍵形式・workers.dev subdomain・secret/API権限・伝播状態を確認。受付は停止のまま原因を調査 |
| verifyでWorker updateがない | no-opには `bootstrap_probe_action=none` を使用。保持PoCの再実施が必要なら、停止bundleのコメント変更などをレビューした新commitでWorker updateを作り、同じready phaseで修正PRをstagingへマージし、新Plan・承認・verifyを行う。class/namespace/tagは変更しない |
| 鍵の値がstate/Plan/read-backへ混入した | PoCを不合格とし、鍵を失効・更新。該当state/artifactの扱いを調査し、provider/deploy方式を修正するまで起動しない |

probeのverify失敗を、鍵の再注入で「保持成功」に置き換えない。保持証明には再注入しないverifyの成功が必要。

Applyが途中失敗した場合、成功部分がstateに残ることがある。state outputだけで未作成と判断せず、各サービスの実資源と照合する。同じphaseでマージ後runの全jobを再実行するか修正PRをマージし、最新stateから再Planする。phaseの飛び越し・巻き戻し、既存Webのimport、D1/Workerのdestroyによるやり直しは行わない。

公開診断は意図的に限定される。raw providerログはrunnerのprivate staging領域にしか残らず、job終了時に削除される。詳細調査が必要な場合はサービス側の監査情報を使い、必要に応じて秘密値を含まない診断を追加する。

Apply jobだけのrerunはrun attemptとmanifestの不一致で拒否される。再試行はマージ後runの **Re-run all jobs** で新attemptのvalidate・Plan・承認をやり直すか、修正PRをstagingへマージする。前回のApply完了後にverifyだけ失敗した場合は、no-opではverifyできないためWorker updateを含む修正PRを使う。後続phaseへ進んだ後で古いphaseのrunを再実行しない。

## 7. 試験後の扱い

stagingはready/pausedのまま保持する。失敗時もconsumerやCronを有効化せず、現在phase・実資源・未解決事項を記録する。Plan artifactは1日保持で、早く削除する場合は対象runのActions画面からartifactを削除する。

専用probe鍵は本runtimeへの置換時にCloudflare secret storeとEnvironmentから削除する。staging資源の撤去はこの試験手順に含めず、削除保護とstateの所有関係を確認した別作業とする。本番切替や旧Trigger停止は移行全体の受入後に実施する。
