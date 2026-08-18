# Supabase接続デプロイ手順書

更新日: 2026-06-21

この手順書は、UptoのWebアプリ（Vercel）とcollector batch（セルフホスト版Trigger.dev）を同じSupabase Postgresへ安全に接続する手順をまとめる。collector自体のデプロイは[サーバーデプロイ・運用手順書](server-deployment-runbook.md)に従う。

## 対象構成

- Web: Vercel上のNext.js App Router
- Batch: Coolifyからデプロイし、セルフホスト版Trigger.dev runnerで実行するcollector
- Database: Supabase Postgres
- Migration: 承認済みの管理端末またはCIからDrizzle Kitを1回だけ実行する

UptoはSupabase Data APIやブラウザ用SDKではなく、`@upto/db`からPostgreSQLへ接続する。`DATABASE_URL`はWebのServer Component / Route HandlerとTrigger.dev taskだけで使用し、ブラウザへ渡さない。

## 接続URLの使い分け

Supabase Dashboardで対象projectを開き、画面上部の **Connect** から各connection stringを取得する。`[YOUR-PASSWORD]`は対象projectのdatabase passwordへ置き換える。passwordを手で埋め込む場合、URL予約文字はpercent-encodeする。

| 設定先 | 変数 | Supabase接続方式 | 用途 |
|---|---|---|---|
| Vercel | `DATABASE_URL` | Transaction pooler、port `6543` | serverlessなWeb runtime |
| Trigger.dev | `DATABASE_URL` | Direct、port `5432` | IPv6対応の永続runner |
| Trigger.dev | `DATABASE_URL` | Session pooler、port `5432` | runnerがIPv4のみの場合の代替 |
| migration実行環境 | `DIRECT_DATABASE_URL` | Direct、port `5432` | Drizzle migration |

VercelのURLをmigrationへ流用しない。Transaction poolerはprepared statementなどsession依存機能に制約があり、migrationや管理コマンドにはDirect connectionを使う。

Direct endpointは標準ではIPv6である。Trigger.dev runnerまたはmigration実行環境からIPv6へ到達できない場合、collector runtimeにはShared PoolerのSession modeを使用する。migrationはIPv6対応環境から実行するか、SupabaseのIPv4 add-onを利用する。Session poolerをmigrationの代替にはしない。

すべてのremote接続でTLSを使用する。Supabase Dashboardが表示する接続文字列を基準にし、`sslmode=disable`を指定しない。

Direct connectionの証明書チェーンを実行環境のNode.jsが信頼できない場合、WebまたはTrigger.dev task runtimeにはSupabase Connect画面から取得したServer root certificateのPEM全文を`DATABASE_SSL_CA`としてSecret設定する。`@upto/db`はこの値をCAとして使い、接続先ホスト名も検証する。task runtimeの`DATABASE_URL`へ開発端末の`sslrootcert`ファイルパスを入れない。Drizzle migrationは`@upto/db`を経由しないため、migration実行環境では従来どおり`DIRECT_DATABASE_URL`の`sslrootcert`でローカルのCAファイルを指定する。

## 1. Supabase projectを準備する

stagingとproductionは別projectにする。少なくとも次を確認する。

1. Supabase accountとorganizationでMFAを有効にする。
2. productionのdatabase passwordをpassword managerで生成・保管する。
3. Dashboardの **Database > Backups** で契約planのbackup条件を確認する。
4. **Database > Settings > SSL Configuration** でSSL enforcementを有効にする。
5. **Connect** からDirect、Session pooler、Transaction poolerの各URLを取得し、secret storeへ保存する。
6. stagingとproductionのproject ref、host、passwordを混在させていないことを二人目が確認する。

Network Restrictionsを使う場合は、VercelとTrigger.dev runner、およびmigration実行元の送信元CIDRをすべて許可してから有効にする。Vercelの送信元IPを固定していない構成で推測したCIDRを設定しない。Direct endpointがIPv6なら、該当するIPv6 CIDRも必要になる。

## 2. migrationを適用する

schema変更を含むreleaseでは、Webとcollectorをデプロイする前にbackup状態を確認し、migrationを1回だけ実行する。taskやWebの起動commandへmigrationを組み込まない。

1. repositoryで対象release commitをcheckoutする。
2. secret storeからproductionのDirect connection URLを`DIRECT_DATABASE_URL`へ注入する。
3. URLの接続先project refを再確認する。
4. 次を実行する。

```bash
pnpm --filter @upto/db db:migrate
```

5. commandが正常終了したことと、Supabase DashboardのTable EditorでUptoのtableが存在することを確認する。
6. shellや一時環境から`DIRECT_DATABASE_URL`を破棄する。

URLをcommand line引数、chat、ticket、CI logへ貼り付けない。`.env`や`.env.local`を本番secretの保管場所にしない。

## 3. WebをVercelへ接続する

Vercel Dashboardの対象projectで **Settings > Environment Variables** を開く。

### staging / Preview

1. `DATABASE_URL`にSupabase staging projectのTransaction pooler URL（port `6543`）を設定する。
2. `DATABASE_POOL_MAX`を`2`に設定する。
3. `UPTO_WEB_USE_FIXTURE_DATA`が未設定、または`false`であることを確認する。
4. 変数の適用先を **Preview** にする。必要ならproduction branch以外の特定branchへ限定する。
5. Preview Deploymentを新しく作成する。既存deploymentには追加・更新した環境変数が遡って反映されない。
6. Preview URLを開き、fixtureではなくstaging DBの記事が表示されることを確認する。

### production

1. `DATABASE_URL`にSupabase production projectのTransaction pooler URL（port `6543`）を設定する。
2. `DATABASE_POOL_MAX=2`を **Production** に設定する。
3. `UPTO_WEB_USE_FIXTURE_DATA`をProductionへ設定しない。
4. production branchの対象commitをデプロイ、または同じcommitをproductionへpromoteしてredeployする。
5. production URLでトップページと`/api/articles?limit=1`を確認する。

`DATABASE_URL`、`DIRECT_DATABASE_URL`、database passwordを`NEXT_PUBLIC_`で始まる変数へ設定しない。Vercelへ`DIRECT_DATABASE_URL`を設定する必要もない。

## 4. collectorをTrigger.devへ接続する

Trigger.dev Dashboardの対象projectで **Project Settings > Environment Variables** を開き、staging / productionを分けて設定する。

1. runnerからSupabase Direct endpointへIPv6疎通できるか確認する。
2. 疎通できる場合はDirect URL、IPv4のみならSession pooler URLを`DATABASE_URL`へ設定し、Secret指定を有効にする。
3. Direct connectionのCAがrunnerで信頼されない場合は、Supabase Server root certificateを`DATABASE_SSL_CA`としてSecret設定する。
4. `DATABASE_POOL_MAX=2`を設定する。
5. 初回は`COLLECTOR_DRY_RUN=false`、`COLLECTOR_CONCURRENCY=1`、`COLLECTOR_MAX_ITEMS_PER_FEED=1`にする。
6. `GEMINI_API_KEY`など、[既定のtask runtime変数](server-deployment-runbook.md#triggerdev-task-runtime)も設定する。
7. deploy hostでcollectorの対象commitをcheckoutし、CLI deployを実行する。
8. Trigger.dev Dashboardで`collect-news`を手動実行する。
9. runが成功し、Supabase上の`crawl_jobs`、`articles`、`article_summaries`へ結果が保存されたことを確認する。
10. 同じ条件でもう一度実行し、`normalized_url`単位で重複が作られないことを確認する。
11. 検証後に件数と並列数を運用値へ戻し、production scheduleを有効にする。

`DATABASE_URL`はTrigger.dev task runtimeへ設定する。deploy hostの`.env`へ設定しても、Trigger.dev runnerのtask runtimeには渡らない。反対に、`TRIGGER_ACCESS_TOKEN`やregistry credentialをtask runtimeへ設定しない。

## 5. production受入確認

次の順番で確認する。

1. migrationが対象production projectへ適用済みである。
2. Trigger.devの手動runが1件以上の記事を保存する。
3. Vercel productionで保存した記事を表示できる。
4. `/api/articles?limit=1`がHTTP `200`とJSONを返す。
5. Trigger.dev run logとVercel logにdatabase URL、password、記事本文、LLM生レスポンスが出ていない。
6. Supabase **Observability** でDatabase Connectionsを確認し、接続数が想定内である。
7. 同じcollector runを再実行しても記事が重複しない。

初期値はWebとcollectorの各processで`DATABASE_POOL_MAX=2`とする。Vercelはinstance数に応じて総接続数が増えるため、単一instanceの値だけで安全と判断しない。Supabaseの接続数とtimeoutを観測したうえで変更する。

## 障害時の切り分け

| 症状 | 主な確認箇所 |
|---|---|
| `ENETUNREACH` / timeout | Direct endpointへIPv6到達できるか、Network Restrictions、DNS、firewall |
| password authentication failed | project、username、database password、URL encoding |
| Webだけ接続できない | VercelがTransaction pooler URLを使っているか、変更後にredeployしたか |
| collectorだけ接続できない | URLがTrigger.dev task environmentにあるか、IPv4-onlyならSession poolerか |
| migrationだけ接続できない | `DIRECT_DATABASE_URL`、migration元のIPv6、Network Restrictions |
| too many connections | Vercel instance数、`DATABASE_POOL_MAX`、Supavisor pool size、stale deployment |
| Webにfixture記事が出る | `UPTO_WEB_USE_FIXTURE_DATA=true`が残っていないか |

認証情報を変更した場合、Supabase、Vercel、Trigger.devの順に新しい値を用意し、両runtimeをredeployして疎通を確認してから古いcredentialを無効化する。

## Rollback

application rollbackだけではDB migrationは元に戻さない。

1. Trigger.devのscheduleとqueueをpauseする。
2. Vercelで直前の正常なapplication deploymentへrollbackする。
3. Trigger.devで直前の正常なdeployment versionをcurrentへ戻す。
4. additiveで後方互換なmigrationならDB schemaは維持する。
5. destructive migrationが原因の場合は、場当たり的な逆SQLを実行せず、backupと復旧手順を確認して承認を得る。
6. collectorを件数`1`で手動実行し、その後Web表示を確認してscheduleを再開する。

## 参照資料

- [Supabase: Connect to your database](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase: Network Restrictions](https://supabase.com/docs/guides/platform/network-restrictions/)
- [Supabase: Production Checklist](https://supabase.com/docs/guides/platform/going-into-prod/)
- [Supabase: Database Backups](https://supabase.com/docs/guides/platform/backups)
- [Vercel: Environment Variables](https://vercel.com/docs/projects/environment-variables)
