# Upto infrastructure as code

Vercel 上の Upto Web project、GitHub 連携、カスタムドメイン紐付けと、Cloudflare DNS の Vercel 向け CNAME/TXT レコードを Terraform で管理する。`apps/web` は Next.js/pnpm workspace として設定し、GitHub への push で Vercel が deployment を作成する。

Terraform state は Cloudflare R2 の S3-compatible backend に保存する。state bucket 自体は bootstrap root module で一度だけ作成するため、bootstrap と production root module の state を分けている。

## Layout

```text
infra/
├── bootstrap/                 # R2 state bucket を一度だけ作成（local state）
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
terraform -chdir=infra/environments/production init -backend-config=backend.hcl
terraform -chdir=infra/environments/production plan
```

`backend.hcl`、`terraform.tfvars`、state file は `.gitignore` 済みである。API token、R2 access key、Vercel token を tfvars やリポジトリへ保存してはならない。
