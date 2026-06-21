# バッチ手動検証手順

更新日: 2026-06-20

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

## 2. Docker image検証

collector直接実行用image:

```bash
docker build -f apps/collector/Dockerfile -t upto-collector:local .
docker run --rm -e COLLECTOR_DRY_RUN=true upto-collector:local
```

Coolify deploy resource用image:

```bash
docker build -f apps/collector/Dockerfile.trigger-deploy -t upto-trigger-deployer:local .
docker run --rm --entrypoint sh upto-trigger-deployer:local -c \
  'docker --version && docker buildx version && pnpm exec trigger --version'
```

期待結果:

- 直接実行imageはdry-run JSONを出して終了する。
- deploy imageにDocker CLI、Buildx、固定versionのTrigger.dev CLIがある。
- image historyやbuild logにsecretがない。

host Docker socketをcontainerへmountしない。

## 3. Deploy script guard検証

必須変数なしでは安全に失敗する。

```bash
env -i PATH=/usr/bin:/bin sh apps/collector/scripts/deploy-trigger.sh
```

期待結果:

- `TRIGGER_API_URL`不足を示して終了する。
- secret値は出力しない。

`DOCKER_HOST=unix:///var/run/docker.sock`を与えた場合もdeploy前に拒否されることを確認する。実在tokenやpasswordはこのguard検証に使わない。

## 4. ローカルdry-run

```bash
pnpm dev:collector
```

期待結果:

- `dryRun: true`のlogが出る。
- network、Gemini、DB writeを行わない。

## 5. ローカル実取得

ローカルPostgreSQLへmigrationを適用する。

```bash
docker compose up -d postgres
pnpm db:migrate
```

`.env`をshellへ読み込み、件数と並列数を絞って実行する。

```bash
set -a
source .env
set +a
COLLECTOR_DRY_RUN=false \
COLLECTOR_MAX_ITEMS_PER_FEED=1 \
COLLECTOR_CONCURRENCY=1 \
pnpm --filter @upto/collector exec tsx src/index.ts
```

期待結果:

- feedごとに開始・終了logが出る。
- 単一記事の失敗があっても他の記事とfeedは継続する。
- 成功記事がDBへ保存される。
- 全feed取得不能の場合はprocessがfailureで終了する。

## 6. DB確認

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

## 7. ローカル冪等性

手順5と同じ条件でもう一度実行する。

期待結果:

- 同じ`normalized_url`の記事行が増えない。
- `summary_status = summarized`の記事ではGemini要約を再実行しない。
- metricsは最新値へ更新される。
- `crawl_jobs`は実行ごとに記録される。

## 8. Trigger.dev local development

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

## 9. Trigger.dev deploy dry-run

専用build executorとregistry認証を利用できる安全な環境で実行する。

```bash
pnpm trigger:deploy:dry-run
```

期待結果:

- task bundleとContainerfileが生成される。
- `@upto/db`、`@upto/domain`、collectorの依存が解決される。
- task runtime imageへ`.env`やsecretが含まれない。

## 10. Trigger.dev staging手動実行

Trigger.dev staging environmentを次の小さい設定にする。

```env
COLLECTOR_DRY_RUN=false
COLLECTOR_CONCURRENCY=1
COLLECTOR_MAX_ITEMS_PER_FEED=1
SUMMARY_CHUNK_CHARS=12000
```

`DATABASE_URL`と`GEMINI_API_KEY`はSecretとして設定する。

dashboardから`collect-news`を実行し、以下を確認する。

- run id、attempt number、deployment versionが表示される。
- 開始・終了logに件数とdurationがある。
- DB URL、API key、記事本文、記事URL、内部error messageがcollector structured logに出ない。
- resultにarticle / feed / failure countがある。
- DBへ記事とfeed jobが保存される。

## 11. Staging再実行

同じrunをReplay / Reattemptする。

期待結果:

- 同一記事のDB重複がない。
- 要約済み記事を不要に再要約しない。
- 新しいrun履歴がdashboardに残る。

## 12. Partial failure検証

test fixtureまたはstaging専用の制御可能なfeedで、1記事だけ失敗させる。

期待結果:

- 他の記事とfeedが継続する。
- runは完了し、`Collector run completed with errors` warningが出る。
- resultの`failedCount`が1以上になる。
- DBに記事statusまたは`crawl_jobs.error_summary`が残る。

production feed URLやsecretを壊して検証しない。

## 13. Fatal failureとretry検証

staging environmentだけで、一時的に到達不能なDB hostnameを設定する。実行後すぐ正しい値へ戻せるよう、元の値を安全なsecret managerで保持する。

期待結果:

- runがfailureになる。
- error logは`errorType`だけを出し、DB URLを出さない。
- 最大2 attemptで停止し、無限retryしない。
- 後続の正常runをqueue concurrency 1で実行できる。

検証後は正しいDB secretへ戻し、件数1で正常実行する。

## 14. Schedule検証

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

## 15. Production前チェック

- stagingとproductionのCoolify resourceが分離されている。
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
