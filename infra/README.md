# Upto infrastructure as code

Vercel 上の Upto Web project、GitHub 連携、カスタムドメイン紐付けと、Cloudflare DNS の Vercel 向け CNAME/TXT レコードを Terraform で管理する。`apps/web` は Next.js/pnpm workspace として設定し、GitHub への push で Vercel が deployment を作成する。

Terraform state は、別リポジトリで管理する Cloudflare R2 bucket の S3-compatible backend に保存する。このリポジトリは bucket 自体を作成・削除しない。

## Layout

```text
infra/
├── environments/
│   └── production/            # R2 remote state を使う本体 root module
└── modules/
    ├── dns/                   # Cloudflare DNS CNAME/TXT
    ├── vercel-domains/        # Vercel project への domain association
    └── vercel-project/        # apps/web のVercel projectとGitHub連携
```

`production` は `vercel_project` resource で `apps/web` のroot directory、Next.js framework、Node.js 24、GitHub repository、production branchを管理する。production branchへのpushはproduction deployment、それ以外のbranchへのpushはpreview deploymentを作成する。

`DATABASE_URL`などのruntime secretはTerraform stateに保存せず、Vercel projectのsecret storeで管理する。既存projectではTerraform import前に、新規projectではTerraform apply後かつ最初のGit push前に、[Supabase接続デプロイ手順書](../docs/supabase-deployment-runbook.md)に従って設定する。

## Local commands

詳細な初期セットアップ、import、GitHub Actions の設定、切り戻しは [Terraform/Vercel/Cloudflare 運用手順書](../docs/terraform-vercel-cloudflare-runbook.md) を参照する。

初期化後の通常の確認は次のとおり。

```bash
terraform -chdir=infra fmt -check -recursive
terraform -chdir=infra/environments/production init
terraform -chdir=infra/environments/production plan
```

`backend.tf` は CI が実行時に backend 定義を注入するための空ファイルである。ローカル実行時の backend 定義は state bucket を管理する別リポジトリの手順で一時注入する。`terraform.tfvars`、state file は `.gitignore` 済みである。API token、R2 access key、Vercel token を tfvars やリポジトリへ保存してはならない。
