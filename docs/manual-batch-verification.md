# バッチ手動検証手順

更新日: 2026-08-18

この手順は、collectorのローカル実行とTrigger.dev staging実行について、RSS/API取得、本文抽出、Gemini要約、PostgreSQL保存、冪等性、ログ、retryを確認するためのものです。

secret、DB URL、token、certificate、記事本文をterminal出力、スクリーンショット、Issue、チャットへ貼らないでください。

## 1. 静的検証

```bash
pnpm --filter @upto/collector test
pnpm --filter @upto/collector typecheck
pnpm --filter @upto/collector build
pnpm format:check
pnpm lint
sh -n apps/collector/scripts/deploy-trigger.sh
```

期待結果:

- collector testが成功する。
- Trigger task adapterを含めてtypecheckできる。
- deploy scriptのshell構文が正しい。

## 2. Deploy hostのDocker検証

collector直接実行用image:

```bash
docker build -f apps/collector/Dockerfile -t upto-collector:local .
docker run --rm -e COLLECTOR_DRY_RUN=true upto-collector:local
```

```bash
docker version
docker buildx version
pnpm exec trigger --version
```

期待結果:

- 直接実行imageはdry-run JSONを出して終了する。
- deploy hostのDocker CLI、Buildx、固定versionのTrigger.dev CLIが利用できる。

deploy scriptはdeploy host上で実行する。Docker socketをCoolify containerへmountしない。

## 3. Deploy script guard検証

必須変数なしでは安全に失敗する。

```bash
env -i PATH=/usr/bin:/bin sh apps/collector/scripts/deploy-trigger.sh
```

期待結果:

- `TRIGGER_API_URL`不足を示して終了する。
- secret値は出力しない。

deploy scriptに古い`DOCKER_HOST`、`DOCKER_TLS_VERIFY`、`DOCKER_CERT_PATH`が残っていても、local Docker daemonを使うために解除される。実在tokenやpasswordはguard検証に使わない。

## 4. ローカルdry-run

```bash
pnpm dev:collector
```

期待結果:

- `dryRun: true`のlogが出る。
- network、Gemini、DB writeを行わない。

## 5. ローカルDBへmigrationを適用する

ローカルPostgreSQLへmigrationを適用する。

```bash
docker compose up -d postgres
pnpm db:migrate
```

Supabase stagingでは、migrationにDirect connectionを使い、collector runtimeにはDirect connectionまたはIPv4向けSession poolerを使う。

```bash
DIRECT_DATABASE_URL='<Supabase Direct connection URL>' pnpm db:migrate
```

URLとpasswordはshell historyやログへ残さないこと。上記は変数の用途を示す例であり、実運用では承認済みsecret storeから注入する。

## 6. DEBUG モードでロールバックと外部通信スキップを確認する

`DEBUG=true` は `COLLECTOR_DRY_RUN` より優先される。DB の開始・完了処理はトランザクションで実行されるが、完了時に必ずロールバックされる。RSS、記事本文、Gemini を含む外部通信は行わないため、`GEMINI_API_KEY` は不要である。

```bash
set -a
source .env
set +a
DEBUG=true pnpm --filter @upto/collector exec tsx src/index.ts
```

期待結果:

- `debug: true` と `debug_external_requests_skipped` のログが出る
- RSS/記事サイト/Gemini への通信は発生しない
- 実行前後で `sources`、`feed_endpoints`、`crawl_jobs`、`articles` の行数が増えない

## 7. 実取得を小さく実行する

`.env`をshellへ読み込み、件数と並列数を絞って実行する。

```bash
set -a
source .env
set +a
COLLECTOR_DRY_RUN=false \
COLLECTOR_MAX_ITEMS_PER_FEED=1 \
COLLECTOR_CONCURRENCY=1 \
GEMINI_REQUESTS_PER_MINUTE=5 \
GEMINI_RATE_LIMIT_MAX_RETRIES=2 \
pnpm --filter @upto/collector exec tsx src/index.ts
```

期待結果:

- feedごとに開始・終了logが出る。
- 単一記事の失敗があっても他の記事とfeedは継続する。
- 成功記事がDBへ保存される。
- 全feed取得不能の場合はprocessがfailureで終了する。
- Gemini 429が発生した場合、最大2回の追加再試行後も失敗した記事だけが失敗として記録される。

## 8. DB保存結果を確認する

```bash
docker compose exec postgres psql -U upto -d upto
```

```sql
select status, count(*)
from crawl_jobs
group by status
order by status;

select
  a.title,
  a.fetch_status,
  a.summary_status,
  a.retry_count,
  a.published_at
from articles a
order by a.created_at desc
limit 10;

select normalized_url, count(*)
from articles
group by normalized_url
having count(*) > 1;
```

最後のqueryは0件であることを確認する。

## 9. ローカル冪等性

手順7と同じ条件でもう一度実行する。

期待結果:

- 同じ`normalized_url`の記事行が増えない。
- `summary_status = summarized`の記事ではGemini要約を再実行しない。
- metricsは最新値へ更新される。
- `crawl_jobs`は実行ごとに記録される。

## 10. Trigger.dev local development

Trigger.dev self-hosted instanceへのlocal profileまたは以下の非secret設定を準備する。

```env
TRIGGER_API_URL=https://trigger.example.invalid
TRIGGER_PROJECT_REF=proj_example
```

認証情報は`.env.example`へ書かない。準備後に実行する。

```bash
pnpm trigger:dev
```

期待結果:

- `apps/collector/src/trigger/collect-news.ts`が検出される。
- task idが`collect-news`になる。
- queue concurrencyが1、最大attemptが2として表示される。
- dashboardのTestからdry-runを起動できる。

## 11. Trigger.dev deploy dry-run

registry認証を設定済みのdeploy host上で実行する。

```bash
pnpm trigger:deploy:dry-run
```

期待結果:

- task bundleとContainerfileが生成される。
- `@upto/db`、`@upto/domain`、collectorの依存が解決される。
- task runtime imageへ`.env`やsecretが含まれない。

## 12. Trigger.dev staging手動実行

Trigger.dev staging environmentを次の小さい設定にする。

```env
COLLECTOR_DRY_RUN=false
COLLECTOR_CONCURRENCY=2
COLLECTOR_MAX_ITEMS_PER_FEED=1
SUMMARY_CHUNK_CHARS=12000
GEMINI_REQUESTS_PER_MINUTE=5
GEMINI_RATE_LIMIT_MAX_RETRIES=2
```

`DATABASE_URL`と`GEMINI_API_KEY`はSecretとして設定する。
`DATABASE_POOL_MAX=2`を設定し、Supabaseの接続数を監視してから増やす。

dashboardから`collect-news`を実行し、以下を確認する。

- run id、attempt number、deployment versionが表示される。
- 開始・終了logに件数とdurationがある。
- DB URL、API key、記事本文、記事URL、内部error messageがcollector structured logに出ない。
- resultにarticle / feed / failure countがある。
- DBへ記事とfeed jobが保存される。

少数の新規記事で、Gemini送信が6件以上になる条件（複数記事または長文のチャンク要約）を作る。Trigger.devの時刻付きlogとGemini usage / quotaを照合し、`gemini_rate_limit_wait`が出た場合は6件目以降が最初の5件中もっとも古い開始から60秒経過するまで送信されないことを確認する。429が発生した場合も、再試行前に待機し、残りの記事が継続することを確認する。記事本文、URL、API key、Gemini生レスポンスを記録しない。

## 13. Staging再実行

同じrunをReplay / Reattemptする。

期待結果:

- 同一記事のDB重複がない。
- 要約済み記事を不要に再要約しない。
- 新しいrun履歴がdashboardに残る。

## 14. Partial failure検証

test fixtureまたはstaging専用の制御可能なfeedで、1記事だけ失敗させる。

期待結果:

- 他の記事とfeedが継続する。
- runは完了し、`Collector run completed with errors` warningが出る。
- resultの`failedCount`が1以上になる。
- DBに記事statusまたは`crawl_jobs.error_summary`が残る。

production feed URLやsecretを壊して検証しない。

## 15. Fatal failureとretry検証

staging environmentだけで、一時的に到達不能なDB hostnameを設定する。実行後すぐ正しい値へ戻せるよう、元の値を安全なsecret managerで保持する。

期待結果:

- runがfailureになる。
- error logは`errorType`だけを出し、DB URLを出さない。
- 最大2 attemptで停止し、無限retryしない。
- 後続の正常runをqueue concurrency 1で実行できる。

検証後は正しいDB secretへ戻し、件数1で正常実行する。

## 16. Schedule検証

dashboardで一時scheduleを作成する。

- Task: `collect-news`
- Environment: staging
- Timezone: `Asia/Tokyo`
- Cron: 数分以内に1回確認できる一時pattern

期待結果:

- 表示された次回時刻にrunが作成される。
- 手動runが実行中なら後続runはqueueで待つ。
- 実行履歴とlogを確認できる。

確認後、一時scheduleを削除する。

## 17. Production前チェック

- stagingとproductionの`TRIGGER_DEPLOY_ENV`を取り違えず、同じ検証済みcommitを明示的にdeployする。
- production branchはrequired checks付きで保護されている。
- Trigger.dev、CLI、SDKのversionが互換で固定されている。
- 旧systemd timerが停止している。
- production scheduleのtimezoneとcronを二名確認または時間を置いて再確認した。
- rollback対象の直前deployment versionを記録した。
- Trigger.dev worker、registry、Upto DBのbackupと空き容量を確認した。

## 後片付け

ローカルPostgreSQLを残す場合:

```bash
docker compose stop postgres
```

ローカルデータも削除する場合だけ、対象を確認して次を実行する。

```bash
docker compose down -v
```

`down -v`はDB dataを削除する。本番や共有DBでは実行しない。
