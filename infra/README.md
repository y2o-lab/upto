# Upto infrastructure as code

Vercel上のUpto Web project、GitHub連携、カスタムドメイン紐付けと、Cloudflare DNSのVercel向けA/CNAME/TXT recordをTerraformで管理する。`apps/web`はNext.js/pnpm workspaceとして設定し、GitHubへのpushでVercelがdeploymentを作成する。

Terraform state は、別リポジトリで管理する Cloudflare R2 bucket の S3-compatible backend に保存する。このリポジトリは bucket 自体を作成・削除しない。

## Layout

```text
infra/
├── environments/
│   ├── production/            # 既存Web
│   ├── collector-staging/     # 停止状態からbootstrapするcollector
│   └── collector-production/  # stagingとは別state・資源名
└── modules/
    ├── dns/                   # Cloudflare DNS A/CNAME/TXT
    ├── vercel-domains/        # Vercel project への domain association
    ├── vercel-project/        # apps/web のVercel projectとGitHub連携
    ├── vercel-collector/      # Git連携なしのNode collector project
    └── cloudflare-collector/  # D1 / Queue / Worker / Workflow / DO / Cron
```

`production` は `vercel_project` resource で `apps/web` のroot directory、Next.js framework、Node.js 24、GitHub repository、production branchを管理する。`release` の Web production deployment は GitHub Actions がDB migrationの成功後にVercel CLIで実行する。Vercel Git連携による`release`の自動deploymentは`apps/web/vercel.json`で停止する。Previewは`test`へのpushだけを対象とし、`apps/web/**`、`packages/**`、またはworkspace依存設定（root `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`）に差分がある場合だけ作成する。ほかのbranchおよび対象外の差分ではbuildを中止する。

`DATABASE_URL`などのruntime secretはTerraform stateに保存せず、Vercel projectのsecret storeで管理する。既存projectではTerraform import前に、新規projectではTerraform apply後かつ最初のGit push前に、[Supabase接続デプロイ手順書](../docs/supabase-deployment-runbook.md)に従って設定する。

## Local commands

詳細な初期セットアップ、import、GitHub Actions の設定、切り戻しは [Terraform/Vercel/Cloudflare 運用手順書](../docs/terraform-vercel-cloudflare-runbook.md) を参照する。

初期化後の通常の確認は次のとおり。

```bash
terraform -chdir=infra fmt -check -recursive
terraform -chdir=infra/environments/production init
terraform -chdir=infra/environments/production plan
```

`variables.tf`はproduction固有の非secret設定を、`backend.tf`はR2 backendの非secret設定を管理する。Vercelが推奨するDNS targetは`vercel_domain_config`から取得する。`terraform.tfvars`、state fileは`.gitignore`済みである。API token、R2 Access Key ID、R2 Secret Access Key、Vercel tokenをtfvarsやリポジトリへ保存してはならない。

## Collector Terraform

collectorの停止基盤を `environments/collector-staging` と `environments/collector-production` に実装した。資源名は `upto-collector-<環境>-*`、R2 state keyは `collector-<環境>/terraform.tfstate`。既存Web root・DNS・外部管理のR2 bucketを移管しない。

Terraform 1.11.4、Cloudflare provider 5.24.0、Vercel provider 5.14.0を固定し、lockfileを保持する。認証なしの検証は以下を使う（初回provider downloadにはネットワークが必要）。

```sh
pnpm test:infra
```

Web rootのvalidate、両collector rootと新moduleのmock test、実provider schema、暗号化Plan/CI契約、停止bundleのNodeテストを実行する。実サービスの作成・secret保持・実workerd挙動はこの検証に含まれない。

実Plan/Applyは `.github/workflows/terraform-collector.yml` を使用する。必要なEnvironment設定、段階的bootstrap、stagingでのsecret保持PoCは [collector Terraform運用](../docs/terraform-vercel-cloudflare-runbook.md#collector-terraform運用) を参照する。現行CIはbootstrap専用で、consumer/Cronの有効化を拒否する。Cloudflareの本runtime、D1 table migration、稼働runtimeの接続検証は別工程である。Apply/probe成功後、同じcommitのVercel FunctionsをActionsからcollector projectへdeployし、Node受付は明示的に停止する。ADR-0008とTrigger.dev運用は切り替えない。

初回staging検証は [Collector Terraform staging検証手順](../docs/collector-terraform-staging-verification.md) の順に進める。Environmentと鍵の準備、各phaseのActions入力、合格条件、失敗時の再試行をまとめている。

stagingは `staging` 向けPRで参考Planを実行し、マージ後のcommitで保存Planを作成して承認後にApplyする。非secret値は各rootの `variables.tf` の `default` をPRで変更する。phaseは `settings.default.bootstrap_phase`、stagingのprobeは `bootstrap_probe_action.default` で指定する。設定JSONは使わず、CIはTerraform consoleでdefaultを評価する。GitHub Variablesは不要。TODOを実値へ置換し、両環境の予約domainを初回Plan前に記入する。stagingの直接pushや手動dispatchではApplyしない。productionの手動経路は `release-infra` に分離している。
