# サーバーデプロイ・運用手順書

更新日: 2026-08-08

この手順書は、ADR-0004およびADR-0005に従い、Upto collectorをセルフホスト版Trigger.devへデプロイし、Trigger.devでschedule、ログ、実行履歴、再実行を管理するための手順をまとめる。

## 対象構成

- Source: GitHub repositoryの保護されたproduction branch
- Deploy control: 同一サーバー上で運用者が実行するCLI
- Task build: deploy hostのlocal Docker daemon / Buildx
- Task registry/runtime: セルフホスト版Trigger.devのregistry、supervisor、runner
- Application DB: Upto用PostgreSQL
- AI: Gemini API

Trigger.dev本体のwebapp、Redis、内部PostgreSQL、object storage、registry、supervisorはこのリポジトリでは管理しない。

## 実行モデル

Coolify上でcollector processを常駐させたり、Trigger.devが既存collector containerを外部起動したりはしない。

1. 運用者が検証済みのGit commitをdeploy host上でcheckoutする。
2. `deploy-trigger.sh`がlocal Docker daemonでtask imageをbuildし、registryへpushする。
3. `trigger.dev deploy`がTrigger.devへdeployment versionを登録する。
4. Trigger.dev supervisor / runnerがscheduleまたは手動操作に応じてtask imageを実行する。

GitHubへのmergeはdeploymentを自動実行しない。staging検証後、同じcommitをproductionとして明示的にdeployする。

## 必須条件

### Trigger.dev

- self-hosted Trigger.dev v4.4.6、またはCLI/SDK 4.4.6との互換性を確認済みのversion
- productionとstagingのproject environment
- HTTPSで到達可能なAPI URL
- non-interactive deploy用のaccess token
- workerからpull可能な認証付きregistry

GHCRをregistryとして使う場合、Trigger.dev webappの`DEPLOY_REGISTRY_NAMESPACE`はDocker image repositoryの形式どおり小文字だけにする。GitHubアカウントの表示名に大文字が含まれていても、たとえば`Inoue416`ではなく`inoue416`を設定する。

Trigger.dev本体、rootの`trigger.dev` package、`@trigger.dev/sdk`は同じversion系列へ固定する。本体を更新する場合はpackageとlockfileも同じ変更で更新し、staging deploy後にproductionへ反映する。

### Deploy host

- Docker Buildx対応
- Trigger.dev APIとregistryへHTTPS接続可能
- Trigger.dev registryへpush可能
- CoolifyとTrigger.devを運用するサーバー上で、運用者がCLIを実行する
- deployを実行する運用アカウントがlocal Docker daemonへアクセス可能

deploy scriptはremote Docker接続用の`DOCKER_HOST`、`DOCKER_TLS_VERIFY`、`DOCKER_CERT_PATH`を解除し、deploy hostのlocal Docker daemonを使用する。Docker socketをCoolify containerへmountしない。`docker` groupへの所属はDocker daemonを管理できる強い権限を与えるため、deploy専用アカウントだけに付与する。

### Network

Trigger.dev runnerから以下へ接続できることを確認する。

- Upto用PostgreSQL
- RSS/API配信元
- 記事配信元のHTTPS endpoint
- Gemini API
- Trigger.dev registryとobject storage

`DATABASE_URL`のhostnameはTrigger.dev runnerから到達できる名前を使う。`localhost`やローカルDocker Compose専用の`postgres` service名をそのまま使わない。

## 環境変数

### Trigger.dev task runtime

Trigger.dev dashboardのProject Settings > Environment Variablesでstaging / productionごとに設定する。

| 変数                           | secret | 用途                                         | 初期値の目安                             |
| ------------------------------ | -----: | -------------------------------------------- | ---------------------------------------- |
| `DATABASE_URL`                 |    Yes | Upto PostgreSQL接続                          | runnerから到達可能なURL                  |
| `DATABASE_SSL_CA`              |    Yes | Supabase Server root certificate（PEM）      | Direct接続のCAを検証する場合             |
| `DATABASE_POOL_MAX`            |     No | taskごとのDB Pool上限                        | `2`                                      |
| `GEMINI_API_KEY`               |    Yes | Gemini API認証                               | production key                           |
| `GEMINI_MODEL_DEFAULT`         |     No | 通常記事モデル                               | `gemini-3.1-flash-lite`                  |
| `GEMINI_MODEL_IMPORTANT`       |     No | 重要記事モデル                               | `gemini-3.0-flash`                       |
| `GEMINI_REQUESTS_PER_MINUTE`   |     No | 1 collector run内のGeminiリクエスト開始上限  | `5`                                      |
| `GEMINI_RATE_LIMIT_MAX_RETRIES`|     No | Gemini HTTP 429への追加再試行回数            | `2`                                      |
| `DEBUG`                        |     No | DB書込みをロールバックし、外部通信を行わない | 通常は`false`                            |
| `COLLECTOR_DRY_RUN`            |     No | 副作用なし実行                               | staging初回は`true`、productionは`false` |
| `COLLECTOR_CONCURRENCY`        |     No | 記事処理並列数                               | 初期は`1`                                |
| `COLLECTOR_MAX_ITEMS_PER_FEED` |     No | feedごとの最大件数                           | staging初回は`1`、productionは`20`以下   |
| `SUMMARY_CHUNK_CHARS`          |     No | 要約chunk文字数                              | `12000`                                  |

secret作成時はTrigger.devのSecret指定を有効にする。DB URL、API key、記事本文、LLM生レスポンスをtask logへ出さない。

`GEMINI_REQUESTS_PER_MINUTE`と`GEMINI_RATE_LIMIT_MAX_RETRIES`は正の整数である。前者は通常モデル・重要モデル・長文チャンク・最終統合・フォールバック・429再試行を合算した、1 collector run内の開始数上限である。値を変更したら対象environmentへ再deployし、少数記事の手動runで設定値とGemini使用量を確認する。

Supabase Direct connectionのCAがrunnerのNode.js信頼ストアにない場合は、Connect画面から取得したServer root certificateのPEM全文を`DATABASE_SSL_CA`へ設定する。`DATABASE_URL`には`sslrootcert`のローカルパスを含めない。`DATABASE_SSL_CA`は改行を含むPEM、または`\n`を含む1行のPEMを受け付ける。

### Deploy hostの環境変数

deploy hostで実行する運用アカウントのsecret管理に設定する。stagingとproductionでは`TRIGGER_DEPLOY_ENV`だけを切り替える。`.env`に保存する場合はGit管理外で、所有者だけが読める権限にする。

| 変数                        | secret | 用途                            |
| --------------------------- | -----: | ------------------------------- |
| `TRIGGER_API_URL`           |     No | self-hosted Trigger.dev API URL |
| `TRIGGER_ACCESS_TOKEN`      |    Yes | non-interactive deploy認証      |
| `TRIGGER_PROJECT_REF`       |     No | Trigger.dev project ref         |
| `TRIGGER_DEPLOY_ENV`        |     No | `staging`または`prod`           |
| `TRIGGER_REGISTRY_HOST`     |     No | deployment image registry       |
| `TRIGGER_REGISTRY_USERNAME` |    Yes | registry login user             |
| `TRIGGER_REGISTRY_PASSWORD` |    Yes | registry login password         |

`TRIGGER_WORKER_TOKEN`はTrigger.dev supervisor専用、`TRIGGER_SECRET_KEY`は外部アプリからtaskを起動する場合のAPI keyである。deploy hostやscheduled taskには設定しない。

## Repository verification

dependency install後、変更をproduction branchへmergeする前に実行する。

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm -r build
sh -n apps/collector/scripts/deploy-trigger.sh
```

Trigger.dev接続情報を安全に設定できる環境では、追加でbuild artifactを確認する。

```bash
pnpm trigger:deploy:dry-run
```

## CLI deploy

deploy hostで対象commitをcheckoutし、必要な環境変数をshellへ読み込む。`DOCKER_HOST`、`DOCKER_TLS_VERIFY`、`DOCKER_CERT_PATH`は設定しない。

```bash
set -a
. ./.env
set +a
sh apps/collector/scripts/deploy-trigger.sh
```

scriptはregistryへloginし、dry-runの後に`TRIGGER_DEPLOY_ENV`で指定したstagingまたはproductionへdeployし、終了時にregistryからlogoutする。deploy host上のDocker socketはscriptを実行する運用アカウントだけがアクセスできるようにする。

## 初回deploy

### 1. Version確認

Trigger.dev本体の固定image tagとpackage versionを比較する。

```bash
pnpm exec trigger --version
```

差異がある場合はdeployせず、互換versionへpackageを揃える。

### 2. staging

1. Trigger.dev staging environmentで`COLLECTOR_DRY_RUN=true`を設定する。
2. deploy hostで`TRIGGER_DEPLOY_ENV=staging`としてCLI deployを実行する。
3. terminal outputでsource commit、dry-run build、staging deployment成功を確認する。
4. Trigger.dev dashboardで`collect-news`とdeployment versionを確認する。
5. dashboardからtaskを手動実行し、dry-run結果を確認する。
6. task environmentを`COLLECTOR_DRY_RUN=false`、件数`1`、並列`1`へ変更する。
7. 再度手動実行し、Upto DBへの保存と冪等性を確認する。

### 3. production

1. staging検証に使用したGit commitをproduction branchへ反映する。
2. Trigger.dev production environmentへruntime変数を設定する。
3. deploy hostで`TRIGGER_DEPLOY_ENV=prod`としてCLI deployを実行する。
4. Trigger.dev dashboardでcurrent deploymentとGit source commitを照合する。
5. scheduleを作成する前に件数`1`で手動実行する。
6. DB保存、Gemini使用量、task result、worker CPU/RAM/diskを確認する。

## Schedule設定

task idは`collect-news`である。scheduleはコードへ埋め込まず、Trigger.dev dashboardで管理する。

1. Schedules > New scheduleを開く。
2. Taskに`collect-news`を選ぶ。
3. cron patternを運用要件に合わせて入力する。
4. Timezoneに`Asia/Tokyo`を明示する。
5. production environmentだけを有効にする。
6. 次回実行時刻を確認する。

task queueのconcurrency limitはコードで`1`に固定している。schedule、手動run、retryが重なった場合、後続runはqueueで待機する。

## ログ・履歴・再実行

Trigger.dev dashboardのRunsから以下を確認する。

- run id、attempt number、deployment version
- 開始・終了、duration
- article / feed / failure count
- feed job id
- partial failure warning
- fatal failureと最大2 attemptのretry
- `gemini_rate_limit_wait`の`waitMilliseconds`と`maxRequestsPerMinute`

記事単位または一部feedの失敗はwarningとして完了し、DBのerror summaryを確認する。設定不備、DB接続不能、全feed取得不能など実行全体が成立しない場合はrun failureとなる。

`gemini_rate_limit_wait`は、Gemini送信前にRPM枠が空くまで待機したことだけを示す構造化ログである。記事本文、URL、API key、Gemini生レスポンスは出力しない。待機が継続して増える場合は、Gemini usage / quotaと`GEMINI_REQUESTS_PER_MINUTE`、記事件数、長文記事数を照合して調整する。

再実行はRunsから対象runを選択してReplay / Reattemptする。再実行後は同一`normalized_url`の重複がなく、要約済み記事で不要なGemini呼出しがないことを確認する。

## DB migration

Trigger.dev taskのdeployとDB migrationは分離する。schema変更があるreleaseでは、task deploymentの前にbackupを取得し、承認済みの運用環境からmigrationを1回だけ実行する。

SupabaseへWebとcollectorの両方を接続する初回設定と受入確認は、[Supabase接続デプロイ手順書](supabase-deployment-runbook.md)に従う。

Supabaseを利用する場合、Trigger.dev runtimeの`DATABASE_URL`にはDirect connectionを使用する。runnerがIPv4のみの場合はShared PoolerのSession modeを使用する。migrationにはpooler URLを流用せず、`DIRECT_DATABASE_URL`へDirect connectionを設定する。

```bash
export DIRECT_DATABASE_URL='<Supabase Direct connection URL>'
pnpm --filter @upto/db db:migrate
```

task image起動時にmigrationを自動実行しない。複数runによる同時migrationを避け、失敗時にtask deploymentとDB状態を個別に判断できるようにする。

## 旧systemd timerの停止

既存サーバーに旧timerがある場合、production scheduleを有効化する前に手動で停止する。

```bash
sudo systemctl disable --now upto-collector.timer
systemctl list-timers upto-collector.timer
```

service unitは監査用に一時保持してよいが、起動しない。Trigger.devの初回production schedule成功後、不要なunit fileを運用者が削除する。

## Rollback

1. Trigger.dev dashboardで`collect-news`のqueueをpauseし、scheduleをdeactivateする。
2. 実行中runは外部書込みの途中である可能性があるため、原則として完了を待つ。
3. Trigger.devで直前の正常なdeployment versionをcurrentへpromoteする。
4. environment変更が原因なら以前の値へ戻す。secret値を作業logへ記録しない。
5. 件数`1`で手動実行し、DBとlogを確認する。
6. 正常化後にqueueとscheduleを再開する。

deploy host上でsource commitを戻すだけではTrigger.devのcurrent deploymentは戻らない。source commitとTrigger.dev task versionを別々に確認する。

DB migrationを戻す自動手順はない。破壊的migrationは事前にforward-compatibleな移行・復旧手順を別途作成する。

## Secret rotation

- Gemini / DB secret: Trigger.dev environmentで更新後、件数`1`の手動runを行う。
- Trigger access token: deploy hostで更新後、staging deployを行う。
- Registry credential: registry、deploy host、Trigger.dev workerの順序を計画し、pushとpullを両方検証する。

rotation中も古い値と新しい値をlogへ出さない。

## 監視・バックアップ

最低限、以下を監視する。

- Trigger.dev webapp / supervisor / runnerの死活
- schedule欠落、queue滞留、連続run failure
- worker CPU、RAM、disk
- registry容量と古いdeployment image cleanup
- Trigger.dev内部PostgreSQL、Redis、object storageの永続volume
- Upto PostgreSQLのbackupと復元確認
- Gemini rate limitと利用量

Trigger.dev self-hosted環境にはmanaged auto-scaling、warm start、checkpointがないため、worker resourceと可用性は運用側で管理する。

## Web deployment

WebはVercelまたは既存のオンプレ構成を継続する。Vercelでは`DATABASE_URL`にSupabase Transaction pooler（port 6543）を設定し、`DATABASE_POOL_MAX=2`から開始する。Web runtimeとTrigger.dev runnerでは推奨される接続方式が異なるため、同じSupabase DBを利用してもURLを流用しない。

## トラブルシュート

### Taskがdashboardに表示されない

- deploy scriptの終了codeを確認する。
- `TRIGGER_API_URL`、`TRIGGER_ACCESS_TOKEN`、`TRIGGER_PROJECT_REF`を確認する。
- Trigger.dev本体とCLI/SDKのversionを確認する。
- `trigger.config.ts`のtask directoryを確認する。

### Buildまたはpushに失敗する

- deploy hostで`docker version`が成功するか確認する。
- deploy hostからregistryの名前解決とTLSを確認する。
- registry credentialを確認する。credential値はlogへ貼らない。
- deploy hostのdisk空き容量とBuildxを確認する。
- `invalid reference format: repository name (...) must be lowercase`の場合、Coolifyで管理しているTrigger.dev serviceの`DEPLOY_REGISTRY_NAMESPACE`を小文字へ修正し、serviceを再デプロイする。Coolify生成物である`/data/coolify/services/.../docker-compose.yml`を直接編集しない。
- build logに認証情報が出力された可能性がある場合は、当該tokenを直ちにrevoke/rotateし、以後は値を伏せて共有する。

### Runnerがtask imageをpullできない

- supervisor側のregistry URL、credential、CAを確認する。
- deploy実行機とworkerで同じregistry namespaceを参照しているか確認する。
- deployment versionをpromote済みか確認する。

### DB接続に失敗する

- Trigger.dev runnerから見たhostname、port、TLS、firewallを確認する。
- `localhost`やCompose専用service名になっていないか確認する。
- migration適用状態を確認する。

### Runは成功だが失敗記事がある

- resultの`failedCount`とwarning logを確認する。
- `crawl_jobs.error_summary`と記事statusを確認する。
- 単一記事失敗はbatch全体を停止しない仕様である。

### Runが繰り返し実行される

- Trigger.devのscheduleとrun retryを確認する。
- 旧systemd timerが停止済みか確認する。
- task deploymentはsource deploy時ではなく、運用者がdeploy scriptを実行した時だけ行われる。collector自体はdeploy host上で起動しないことを確認する。

## 参照

- [ADR-0004](adr/0004-batch-deployment-with-trigger-dev.md)
- [ADR-0005](adr/0005-local-cli-trigger-task-deployment.md)
- [Trigger.dev self-hosting with Docker](https://trigger.dev/docs/self-hosting/docker)
- [Trigger.dev deployment](https://trigger.dev/docs/deployment/overview)
- [Trigger.dev scheduled tasks](https://trigger.dev/docs/tasks/scheduled)
