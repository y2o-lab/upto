# Terraform による Vercel / Cloudflare DNS 運用手順書

更新日: 2026-08-27

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
5. `release`へcommitをpushし、Vercelがproduction deploymentを作成することを確認します。`test`へ`apps/web/**`、`packages/**`、またはworkspace依存設定を変更するcommitをpushし、Preview deploymentが作成されることを確認します。ほかのbranch、または対象外の変更だけの`test` commitではbuildが中止されることを確認します。
6. 実ドメインと `https://<domain>/api/articles?limit=1` を確認します。DB URL や token がresponse、Vercel log、Actions logに出ていないことも確認します。

問題時はまずActionsのapplyを止め、`terraform plan`でstateと実環境の差分を確認します。DNSをTerraform外で手修正してすぐにapplyするのは避けます。Vercelの直前deploymentへのrollbackはVercel dashboardで行えますが、DNS/domainを戻す場合は、このリポジトリの`variables.tf`を前の意図した値へ戻し、review済みのplanをapplyしてください。R2 state bucketとstate objectは削除しません。
