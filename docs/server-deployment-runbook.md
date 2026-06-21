# サーバーデプロイ・運用手順書

更新日: 2026-06-20

この手順書は、ADR-0004に従い、Upto collectorをオンプレのCoolifyからセルフホスト版Trigger.devへデプロイし、Trigger.devでschedule、ログ、実行履歴、再実行を管理するための手順をまとめる。

## 対象構成

- Source: GitHub repositoryの保護されたproduction branch
- Deploy control: CoolifyのGitHub webhook / Auto Deploy
- Task build: Coolify deploy resourceから接続する専用remote Docker/BuildKit executor
- Task registry/runtime: セルフホスト版Trigger.devのregistry、supervisor、runner
- Application DB: Upto用PostgreSQL
- AI: Gemini API

Trigger.dev本体のwebapp、Redis、内部PostgreSQL、object storage、registry、supervisorはこのリポジトリでは管理しない。

## 実行モデル

Coolify上でcollector processを常駐させたり、Trigger.devが既存collector containerを外部起動したりはしない。

1. GitHub pushをCoolifyが受信する。
2. Coolifyが`apps/collector/Dockerfile.trigger-deploy`をbuildする。
3. 新しいdeploy resource containerでpost-deployment commandを1回実行する。
4. `trigger.dev deploy`がtask imageを専用build executorでbuildし、Trigger.dev registryへpushする。
5. Trigger.devがdeployment versionを登録する。
6. Trigger.dev supervisor / runnerがscheduleまたは手動操作に応じてtask imageを実行する。

`apps/collector/Dockerfile`はローカル・障害調査用のcollector直接実行imageとして残す。Trigger.devのdeployment imageはCLIが生成するため、このDockerfileを本番task runtimeとしてCoolifyに常駐させない。

## 必須条件

### Trigger.dev

- self-hosted Trigger.dev v4.4.6、またはCLI/SDK 4.4.6との互換性を確認済みのversion
- productionとstagingのproject environment
- HTTPSで到達可能なAPI URL
- non-interactive deploy用のaccess token
- workerからpull可能な認証付きregistry

Trigger.dev本体、rootの`trigger.dev` package、`@trigger.dev/sdk`は同じversion系列へ固定する。本体を更新する場合はpackageとlockfileも同じ変更で更新し、staging deploy後にproductionへ反映する。

### 専用build executor

- Docker Buildx対応
- Coolify deploy resourceからTLS相互認証付き`tcp://`で接続可能
- Trigger.dev registryへpush可能
- Upto以外のproduction workloadを実行しない分離されたhostまたはVM

`/var/run/docker.sock`をCoolify deploy containerへmountしない。deploy scriptは`unix://`接続とTLSなしのremote Docker接続を拒否する。

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

| 変数 | secret | 用途 | 初期値の目安 |
|---|---:|---|---|
| `DATABASE_URL` | Yes | Upto PostgreSQL接続 | runnerから到達可能なURL |
| `GEMINI_API_KEY` | Yes | Gemini API認証 | production key |
| `GEMINI_MODEL_DEFAULT` | No | 通常記事モデル | `gemini-3.1-flash-lite` |
| `GEMINI_MODEL_IMPORTANT` | No | 重要記事モデル | `gemini-3.0-flash` |
| `COLLECTOR_DRY_RUN` | No | 副作用なし実行 | staging初回は`true`、productionは`false` |
| `COLLECTOR_CONCURRENCY` | No | 記事処理並列数 | 初期は`1` |
| `COLLECTOR_MAX_ITEMS_PER_FEED` | No | feedごとの最大件数 | staging初回は`1`、productionは`20`以下 |
| `SUMMARY_CHUNK_CHARS` | No | 要約chunk文字数 | `12000` |

secret作成時はTrigger.devのSecret指定を有効にする。DB URL、API key、記事本文、LLM生レスポンスをtask logへ出さない。

### Coolify deploy resource

staging / production resourceごとに設定する。

| 変数 | secret | 用途 |
|---|---:|---|
| `TRIGGER_API_URL` | No | self-hosted Trigger.dev API URL |
| `TRIGGER_ACCESS_TOKEN` | Yes | non-interactive deploy認証 |
| `TRIGGER_PROJECT_REF` | No | Trigger.dev project ref |
| `TRIGGER_DEPLOY_ENV` | No | `staging`または`prod` |
| `TRIGGER_REGISTRY_HOST` | No | deployment image registry |
| `TRIGGER_REGISTRY_USERNAME` | Yes | registry login user |
| `TRIGGER_REGISTRY_PASSWORD` | Yes | registry login password |
| `DOCKER_HOST` | No | 専用executorの`tcp://host:port` |
| `DOCKER_TLS_VERIFY` | No | 必ず`1` |
| `DOCKER_CERT_PATH` | No | client certificate mount path |

Coolifyのpersistent storageまたはsecret file機能で、`DOCKER_CERT_PATH`に`ca.pem`、`cert.pem`、`key.pem`をread-only mountする。certificateやtokenをGit、Docker build argument、image layerへ含めない。

`TRIGGER_WORKER_TOKEN`はTrigger.dev supervisor専用、`TRIGGER_SECRET_KEY`は外部アプリからtaskを起動する場合のAPI keyである。collector deploy resourceやscheduled taskには設定しない。

## Repository verification

dependency install後、変更をproduction branchへmergeする前に実行する。

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm -r build
sh -n apps/collector/scripts/deploy-trigger.sh
docker build -f apps/collector/Dockerfile.trigger-deploy .
```

Trigger.dev接続情報を安全に設定できる環境では、追加でbuild artifactを確認する。

```bash
pnpm trigger:deploy:dry-run
```

## Coolify resource設定

stagingとproductionを別resourceにする。これによりtoken、environment、deployment履歴、手動承認を分離する。

共通設定:

| 項目 | 値 |
|---|---|
| Source | GitHub Appまたは認証済みGitHub repository |
| Base directory | `/` |
| Build pack | Dockerfile |
| Dockerfile | `/apps/collector/Dockerfile.trigger-deploy` |
| Domain / exposed port | なし |
| Health check | 無効 |
| Rolling update | 無効 |
| Post-deployment command | `/app/apps/collector/scripts/deploy-trigger.sh` |
| Auto Deploy | production branchで有効 |

deploy resource containerの`CMD`は`node` userで`sleep infinity`を実行する。collector taskはこのcontainer内では動かない。post-deployment commandだけが専用executorを利用する。

GitHub側では次を設定する。

1. CoolifyのAuto Deployを有効にする。
2. webhookを手動作成する場合はrandomなsecretを設定する。
3. SSL verificationを有効にする。
4. push eventだけを購読する。
5. production branchを保護し、`pnpm verify`をrequired checkにする。
6. 直接pushを禁止し、required checkに成功したPRだけをmergeする。

可能ならwatch pathを以下へ限定する。

```text
apps/collector/**
packages/db/**
packages/domain/**
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
trigger.config.ts
.dockerignore
```

## 初回deploy

### 1. Version確認

Trigger.dev本体の固定image tagとpackage versionを比較する。

```bash
pnpm exec trigger --version
```

差異がある場合はdeployせず、互換versionへpackageを揃える。

### 2. staging

1. Trigger.dev staging environmentで`COLLECTOR_DRY_RUN=true`を設定する。
2. Coolify staging resourceでmanual deployする。
3. Coolify logでsource commit、dry-run build、staging deployment成功を確認する。
4. Trigger.dev dashboardで`collect-news`とdeployment versionを確認する。
5. dashboardからtaskを手動実行し、dry-run結果を確認する。
6. task environmentを`COLLECTOR_DRY_RUN=false`、件数`1`、並列`1`へ変更する。
7. 再度手動実行し、Upto DBへの保存と冪等性を確認する。

### 3. production

1. staging検証に使用したGit commitをproduction branchへ反映する。
2. Trigger.dev production environmentへruntime変数を設定する。
3. Coolify production resourceをmanual deployする。
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

記事単位または一部feedの失敗はwarningとして完了し、DBのerror summaryを確認する。設定不備、DB接続不能、全feed取得不能など実行全体が成立しない場合はrun failureとなる。

再実行はRunsから対象runを選択してReplay / Reattemptする。再実行後は同一`normalized_url`の重複がなく、要約済み記事で不要なGemini呼出しがないことを確認する。

## DB migration

Trigger.dev taskのdeployとDB migrationは分離する。schema変更があるreleaseでは、task deploymentの前にbackupを取得し、承認済みの運用環境からmigrationを1回だけ実行する。

```bash
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

Coolifyのapplication rollbackだけではTrigger.devのcurrent deploymentは戻らない。Coolifyのsource commitとTrigger.dev task versionを別々に確認する。

DB migrationを戻す自動手順はない。破壊的migrationは事前にforward-compatibleな移行・復旧手順を別途作成する。

## Secret rotation

- Gemini / DB secret: Trigger.dev environmentで更新後、件数`1`の手動runを行う。
- Trigger access token: Coolify resourceで更新後、staging deployを行う。
- Registry credential: registry、Coolify、Trigger.dev workerの順序を計画し、pushとpullを両方検証する。
- Docker TLS certificate: 専用executorとCoolify mountを更新し、`docker version`成功後にdeployする。

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

Webはこの変更の対象外である。Vercelまたは既存のオンプレ構成を継続する。WebからUpto PostgreSQLへ接続する`DATABASE_URL`はWeb runtimeのnetwork基準で設定し、Trigger.dev runner用URLと同じとは限らない。

## トラブルシュート

### Taskがdashboardに表示されない

- Coolify post-deployment commandの終了codeを確認する。
- `TRIGGER_API_URL`、`TRIGGER_ACCESS_TOKEN`、`TRIGGER_PROJECT_REF`を確認する。
- Trigger.dev本体とCLI/SDKのversionを確認する。
- `trigger.config.ts`のtask directoryを確認する。

### Buildまたはpushに失敗する

- `DOCKER_HOST`が専用executorの`tcp://` URLか確認する。
- `DOCKER_TLS_VERIFY=1`とclient certificate mountを確認する。
- deploy resourceからregistryの名前解決とTLSを確認する。
- registry credentialを確認する。credential値はlogへ貼らない。
- executorのdisk空き容量とBuildxを確認する。

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
- Coolify post-deployment commandはsource deploy時だけ実行され、collector自体を起動していないことを確認する。

## 参照

- [ADR-0004](adr/0004-batch-deployment-with-trigger-dev.md)
- [Trigger.dev self-hosting with Docker](https://trigger.dev/docs/self-hosting/docker)
- [Trigger.dev deployment](https://trigger.dev/docs/deployment/overview)
- [Trigger.dev scheduled tasks](https://trigger.dev/docs/tasks/scheduled)
- [Coolify Dockerfile build pack](https://coolify.io/docs/applications/build-packs/dockerfile)
- [Coolify GitHub Auto Deploy](https://coolify.io/docs/applications/ci-cd/github/auto-deploy)
