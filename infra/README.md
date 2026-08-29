# Upto infrastructure as code

Vercel上のUpto Web project、GitHub連携、カスタムドメイン紐付けと、Cloudflare DNSのVercel向けA/CNAME/TXT recordをTerraformで管理する。`apps/web`はNext.js/pnpm workspaceとして設定し、GitHubへのpushでVercelがdeploymentを作成する。

Terraform state は、別リポジトリで管理する Cloudflare R2 bucket の S3-compatible backend に保存する。このリポジトリは bucket 自体を作成・削除しない。

## Layout

```text
infra/
├── environments/
│   └── production/            # R2 remote state を使う本体 root module
└── modules/
    ├── dns/                   # Cloudflare DNS A/CNAME/TXT
    ├── vercel-domains/        # Vercel project への domain association
    └── vercel-project/        # apps/web のVercel projectとGitHub連携
```

`production` は `vercel_project` resource で `apps/web` のroot directory、Next.js framework、Node.js 24、GitHub repository、production branchを管理する。`release` へのpushはproduction deploymentを作成する。Previewは`test`へのpushだけを対象とし、`apps/web/**`、`packages/**`、またはworkspace依存設定（root `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`）に差分がある場合だけ作成する。ほかのbranchおよび対象外の差分ではbuildを中止する。

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
