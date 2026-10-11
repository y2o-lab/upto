# Cloudflare / Vercel collector 運用手順

全体構成と記事処理フローは[システム構成・アーキテクチャ図](system-architecture.md)を参照する。

## 現在の利用範囲

移行実装中。現行Trigger.dev運用を継続し、ADR-0008はProposedのまま保持する。
新collectorのdeploy、実migration、Cron有効化、旧Trigger停止はまだ実施しない。
本書は実装済みのコマンドだけを記載する。完全な受入仕様は
[ローカル品質計画](cloudflare-vercel-local-quality-plan.md)を参照する。

## Node API入口とビルド

`apps/collector/api/v1` の9入口は共通のWeb Request handlerへ接続する。
`COLLECTOR_NODE_ENABLED` は未設定時に無効で、認証情報なしでimportできる。
有効化後の最初のrequestで明示的なversion・モデル・署名鍵・gate origin・DB設定を検査し、
不正設定は秘密値を含まない503を返す。DB poolは既定2、上限4。
必要な変数名は `apps/collector/.env.example` に記載する。

```sh
pnpm build:collector:node
pnpm typecheck
```

ビルドは共有DB/domainコードとその依存をbundleし、collectorの直接依存を外部参照する。
`build-node/manifest.json` に9成果物とlockfileのSHA-256を記録する。
各成果物を認証情報を引き継がない子Nodeでimportし、無効時の503と、ダミー設定での
未署名requestの401を検証する。これはVercel platform buildや署名付き全stageの代替ではない。
`vercel.json` は300秒のFunction上限とfrozen installを指定するが、deployしていない。
現在のbundleはNode 22互換で検証しており、計画のNode 24環境による確認も残る。

manifestとlockfileの整合チェック（`pnpm install --lockfile-only --offline --frozen-lockfile`）は通る。
これは依存を取得するfresh installの検証ではない。追加したesbuildはlockfileの0.28.2を参照する。
fresh/frozen installと指定versionでの再検証は未完了で、既存node_modulesでのビルドを代用しない。

## 隔離PostgreSQLの試験

Dockerの稼働を確認してから、workspace rootで実行する。

```sh
pnpm test:local:up
pnpm --filter @upto/db test:integration
pnpm test:local:down
```

試験失敗時も最後のdownを実行する。専用Compose project `upto-collector-tests` だけを
終了する。PostgreSQL 17.6の一時storageを使い、Docker socketはcontainerへmountしない。
`127.0.0.1:55439` が必要。他用途のcontainerは停止しない。

接続変数は `COLLECTOR_TEST_DATABASE_URL` のみ。`DATABASE_URL` は使用しない。
接続先はloopbackとDB名 `upto_collector_test` に限定し、不明なqueryや他DBを拒否する。
fixture専用のダミー認証情報を使用する。試験ごとにランダム名の専用DBを作り、
checked-in Drizzle migrationを適用してから開始し、終了時にそのDBを削除する。
プロセス強制終了で残った試験DBはdownで一時storageごと削除できる。
実記事・実Gemini・本番DBには接続しない。

## 実装済みの検証

```sh
pnpm --filter @upto/domain test
pnpm --filter @upto/db test
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
```

通常の `pnpm test` とPG integrationは独立している。通常testの合格だけではPG検証済みとしない。
PG integrationは型検査も必須にしている。単体test用schemaを実DBの代替にしない。
`test:local`、`test:infra`、`verify:local` はCF/HTTP/Web/IaCの実装後に追加する。
未対応の層をskipして完全な検証として扱わない。

## 受入ケースと実装の対応

| 受入機能 | 現在の対応test | 未完了の検証 |
| --- | --- | --- |
| API契約・識別子 | `packages/domain/src/batch/batch.test.ts` | Vercel実deployment照合、指定versionでの受入 |
| operation / PG | `packages/db/integration/{operations,persistence}.integration.test.ts`（同時claim、generation join、epoch、送信不明、応答喪失、保存点rollback、statement timeout） | manual resume、保持/cleanup、CFとの接続 |
| finalize / persist | `publication.integration.test.ts`（4テーブル/result/operation/generation原子公開、各保存点rollback、実persist stage認可とreplay）、既存persistence integration | CFからの集計照合、feed毎のterminal集計、保存記事のWeb実API/Playwright互換 |
| D1状態 | `packages/domain/src/batch/batch.test.ts`（純粋遷移と終端保護のみ） | D1実SQL、CAS、outbox、集計 |
| deadline / retry | 同domain test（retry上限、lookup、deadline境界、quota待機） | CF runtime累積計数、DBへ残りdeadlineの伝播 |
| discovery | `discovery.integration.test.ts`、domain discovery、`apps/collector/src/feeds.test.ts`（固定slot、候補snapshot、URL重複排除、generation共有、feed障害継続、候補障害分離、公開保護、rollback、HN最大4並列、壊れたXML/非feed拒否、正常空feed） | CF/D1とのslot接続、全登録feed形式、各feedのterminal集計 |
| fetch / extract | `extract.integration.test.ts`、`snapshots.integration.test.ts`、domain snapshots/extraction、`http/safe-fetch.test.ts`、`content.test.ts`、`safe-fetch.integration.test.ts`（実stage/署名HTTP、候補認可、入力固定、成功replay、同時実行、原子保存、chunk上限、SSRF/TLS/timeout、Readability/fallback） | CF controlからのprepare/各stage接続、実feed網羅 |
| summarize / merge | `generation-sender.integration.test.ts`、`merge.integration.test.ts`、`apps/collector/integration/gemini-adapter.integration.test.ts`、`gate-client.integration.test.ts`（実PG/SDK/署名HTTP、単一/chunk/統合、公開保存、replay、429上限、uncertain、fallback、SDK retry無効・中断） | DO、token count保存・再利用、CF Workflowからのprepare接続、実API quota/品質 |
| manifests | `packages/db/integration/snapshots.integration.test.ts`（全種別、固定snapshot、paging、署名cursor、別接続の重複登録） | 保持/cleanup、Vercel platformでの検証 |
| 認証 | `packages/domain/src/batch/auth.test.ts`、`packages/db/integration/operations.integration.test.ts`（双方向HMAC、raw body/query、時計差、rotation、PG nonce競合） | CF D1 nonce、Vercel実deployment照合 |
| outbox / Queue / DLQ / Workflow | 未実装 | 実workerd、配送、checkpoint、再起動、旧version replay |
| capacity DO / Gemini gate DO | 未実装 | 実SQLite DO、同時取得、再起動、quota/日次境界 |
| reconciler / cleanup / 運用制御 | 未実装 | 照合、保持、pause/drain、切替・切り戻し |
| logs / errors | `apps/collector/src/http/handler.test.ts`（HTTP error/logの秘密非露出、不正応答拒否、config不足） | CF経路、実サービスでの秘密非露出確認 |
| Terraform / Actions | 未実装 | offline検証、保存Plan、承認・commit/hash/state排他 |
| 全体シナリオ / Web互換 | 未実装 | 品質計画の9シナリオ、実APIから保存記事表示 |

schemaや純粋testは実runtimeの証拠を代替しない。stagingでのtoken更新、承認済み
Plan/Apply、quota/CPU実測、7日以上の観測、切り戻し演習も本番切替の前提として残る。

## 共通認証と永続operationの扱い

共通認証は `@upto/domain/batch` のWeb CryptoによるHMAC-SHA256を使う。
認証version、方向、method、path/canonical query、raw body hash、request ID、nonce、
issued/expires時刻、環境、key ID、executor versionを署名する。TLS必須、ローカルfixtureの
loopback HTTPだけ例外。署名TTL上限60秒、issue時計差5秒、expiry+5秒以上は拒否する。
鍵は32byte以上のダミー/secret store値を使い、本文やsecretをエラーへ含めない。
NodeはPG nonce、CFは今後実装するD1 nonceで再送を拒否する。bypassはHMACの代用にならない。

PG operationは結果成功を最優先で照会する。成功commit後にHTTP応答を失っても、
保存済みresult IDを返し、再生成しない。期限切れでも未送信なら新epochでclaimできるが、
送信済みで結果不明ならattemptとoperationをuncertainにする。uncertainは自動claimしない。
quota待機はattemptを増やさず、明確な429は最大3送信まで別attempt/permitを記録する。
結果とusageとoperation成功は同じtransactionで保存する。古いownerと期限切れownerの
成功・失敗・attempt更新を拒否する。大きな本文等の保存はstageのtransaction callbackを
実装してから有効化する。

runtimeのPG接続取得は最大10秒、statementは最大15秒。残りdeadlineに応じて
`connectionTimeoutMs` / `statementTimeoutMs` で短縮でき、上限を超える設定は拒否する。
Node HTTPからfeed/SDK/gateへAbortSignalを伝播する。DBの各statementへの残りdeadline伝播と
CF Workflowからの接続は未実装で、固定DB timeoutだけで全体期限を保証しない。

現在のローカルインストールはVitest 4.1.11、TypeScript 6.0.3、Node 22.14.0。
manifest/lockfileのVitest 5.0.1、TypeScript 7.0.2、Node 24とは一致していない。
指定版でのfrozen installと再検証、CF runtime互換PoCは未完了。ローカルの結果を
指定版・Cloudflare/Vercel本番runtimeの受入証拠として扱わない。

## 本文・manifest・生成結果のsnapshot

抽出snapshotは本文・HTML・chunker version・順序付きchunkを一括保存する。
本文とHTMLの上限はそれぞれUTF-8で2MiB、chunk上限は64（暫定、staging PoCで受入を確認）。
chunkは既存chunkerの段落空白整形を許容し、空白を除く本文内容の欠落・重複・順序違いを拒否する。
この上限だけで外部HTTP fetchのbyte上限やCPU上限を保証しない。

manifestはcandidate/chunk/resultの3種別。登録済みの参照の所属を検査し、
同一IDに異なるsnapshotを登録しない。cursorは専用32byte以上の署名鍵で環境・manifest・
位置をHMACに結び付ける。この鍵はNode runtime secretとし、Terraformへ値を渡さない。
1pageは最大50件・32KiB。保存済み結果の読出しはenvironment/generation/operation成功を照合し、
validated JSONからoutput hashを再確認する。本文やchunk textをCF向けmanifest応答へ含めない。

generation lease・extract HTTP stage・最終記事公開のtransaction統合は実装済み。
CF Workflowからのprepare接続、非terminal参照を守るcleanupは
続く実装の受入項目として残る。

## Node HTTP境界

`apps/collector/src/http/handler.ts` の共通handlerはWeb標準のRequest/Responseを使う。
Vercelの[Node runtime資料](https://vercel.com/docs/functions/runtimes/node-js)で確認した
`api/v1` の `fetch` export形式へ接続済み。local Node adapterと同じhandlerを使う。
Vercel APIファイル・runtime config・全stage service・credentialなしbuildは実装済みで、
Vercel platform build/deployとCF controlからの接続は未完了。

署名対象のraw bodyを16KiBまで読んでから認証し、JSON化は認証後に行う。
POSTのstage/path一致、環境・executor version・許可config version、strict Zod契約を検査する。
GETのqueryは余分なfield、duplicate field、非canonicalなlimitを拒否する。
responseもschemaと32KiB上限を検査し、DB/SDKのraw error・body・promptをエラー応答や
logging callbackへ渡さない。追跡IDは `x-upto-request-id` に返す。

最大240秒のhandler budgetとrequest deadlineの早い方を実行期限とする。
すでに確定した成功結果のreplayはrequest deadline後も可能。replay前に参照と固定configから
operation identityを解決・再計算する必要があり、keyだけの結果照会で別入力を成功扱いにしない。
期限切れの未成功requestではsnapshot解決を行わず、新しい入力を固定しない。
prepareにもrequest deadlineで中断するtimerを設定する。
新規実行前と応答前に期限を検査し、AbortSignalをserviceへ渡す。処理終了をawaitしてから
応答し、Promise raceだけで実行停止を保証しない。各SDK/fetch/DBへの伝播はstage側で実装する。

`packages/db/integration/http.integration.test.ts` は実loopback HTTP server、同じhandler、
実HMAC、PG nonce、PG extraction snapshotを使う。stage処理は架空本文を保存するfixtureであり、
feed取得・Gemini generate・CF/DO・公開記事/Webを含む全体シナリオの代替にはしない。

## generation所有権と送信不明の扱い

PG operation claimはgeneration rowを先にlockし、続いてoperationをlockする。
generationのowner/epoch/untilをclaimと同じtransactionで取得し、operationに
`generation_epoch` を保存する。PG operation epoch・PG generation epoch・D1 epochは
独立した値として扱う。送信、完了、失敗、waiting更新は両方の所有権と期限を検査する。

同じgenerationの別operationが実行中なら、追加のoperation/attemptを作らずrunningを返す。
quota waiting、明確な429、成功/既知失敗では所有権を解放し、次stageが新epochを取得する。
成功済みoperationのresultはgenerationの所有者が変わっても再利用する。
未送信で期限切れなら再claim可能だが、未確定の送信が一つでもあればgenerationをuncertainにし、
別model・別stage・別operation keyによる自動送信も止める。manual resume/uncertain解決の
運用入口はまだ未実装であり、SQLで状態を一括resetする手順は提供しない。

persist成功によるgeneration完了では、対応articleがsummarizedで、本文・要約・metricsの
行がすべて存在することを同じtransactionで検査する。空のcallbackだけでは完了にしない。
persist stageは公開時にも本文・HTML・chunk順序・hashを再検査し、
candidateのexecutor/config/generation所属とprocess区分を照合する。
version照合と4テーブル書込みは実PGで検証する。公開結果の実Web表示は未検証。`generation-lease.integration.test.ts` は別PG poolの競合、旧epochの送信拒否、
quota waiting、送信不明、最終fencing失敗のrollback、未公開generationの成功拒否を確認する。

追加migrationはnullable `generation_epoch` を加えるだけで既存データを削除しない。
過去のunfenced operationは成功参照を読むことはできるが、所有権を取得せず新しい送信・保存を
行うことは認めない。旧Vercel deploymentとの互換・切替はstaging replay受入の対象として残す。

## persist stageと公開記事の互換性

`apps/collector/src/stages/persist.ts` は保存済みgeneration・最終summary result・payloadを
参照して公開する。環境、generation、prompt/schema/config version、payload hashを検査する。
複数chunkの未統合resultを最終記事として公開しない。job/feed参照はdiscovery/candidate、
articleの正規化URL、legacy crawl jobのsourceとの対応を照合し、replayにも同じ認可を適用する。
metricsは候補のDB metadataから取得し、HTTP本文から任意のscore等を受け取らない。

公開はgeneration→operation→articleのlock順を使い、本文・要約・metrics・記事の公開状態・
persist result・operation成功・generation成功を一つのtransactionで保存する。
要約JSONは既存Trigger/Webと同じsnake_caseへ変換する。既存公開記事は本文・要約・titleを
保護し、metricsだけ更新する。返却するpublished/alreadyPublishedもtransaction内で確定する。

`PublicationRepository.incompletePublished()` は公開済みなのに本文/要約/metrics行がない
記事IDと欠損箇所をread-onlyで列挙する（既定100件、最大1000件）。全記事をpendingへ戻さない。
実DBの欠損確認・計画的修復、実Next.js APIからの保存記事表示、Playwright受入は未実施。

persist/discoveryによる候補metadata作成とNode stage routerは実装済みだが、
Vercel API入口・credentialなしbundle、CFによる実行管理はまだ接続していない。
fixture HTTP試験の合格を全体のCron→公開シナリオの完了として扱わない。

## job-finalizeの集計投影

`FinalizationRepository` と `createJobFinalizeStage` はdiscoveryに保存したCF job→legacy
crawl job対応とexecutor/config versionを照合する。discoveryのnullable `crawl_job_id` を
追加migrationで導入し、古い行を推測で別jobへ紐付けない。discovery作成側で対応を保存する。

countsは非負PG integer、成功/失敗/cancelled合計はfetched以下とする（重複skipは許容）。
count versionは単調増加。古いversion、同じversionの違うcounts/errorは409で拒否し、
同じversionの同じ内容は重複加算しない。projection・legacy集計・result・operation成功は
同じtransaction。既存のrunning/succeeded/failed enumを維持し、cancelledはfailed_countへ
投影する。全feed障害等は件数へ混ぜずsanitized error codeを保存し、成功jobを失敗へ戻さない。

`finalization.integration.test.ts` は実PG別接続による競合、rollback、version/環境境界を検証する。
D1のterminal集計との照合、CF/全stage HTTPシナリオ、実deploymentへの接続は未完了。

## 外部feed・本文の取得制限

`createSafeFetcher()` は既存collectorの既定transport、`fetchFeedItems` と
`extractArticleContent` の既定取得経路へ接続した。HTTPS/443のみ、認証情報付きURLを拒否し、
Cookie/Authorizationを外部へ転送しない。DNSの全回答を検査し、private、loopback、
link-local等を含む回答を拒否する。接続先を検査済みIPへ固定し、redirectごとに再検査する。
redirectは最大5回、全取得20秒、本文は圧縮前後それぞれ最大2MiBとする。
取得失敗は固定error codeへ変換し、本文抽出は既存のfeed fallbackを維持する。
extract stageは同transportを既定で使い、HTTP invocationのAbortSignalを伝播する。
全stage routerとVercel APIファイルは接続済み。CF Workflowからの呼出しは未接続。

`safe-fetch.integration.test.ts` は一時生成したダミー証明書とloopback HTTPS serverで、
証明書検証、redirect、gzip展開、圧縮/展開byte上限、応答body停止の中断を検証する。
public fixture IDからloopbackへの写像とCA指定はtransport注入で行い、本番APIに
制限を解除するendpointや環境変数を設けない。試験後にserverと一時鍵を削除する。
このTLS試験だけなら専用PGの起動は不要で、次のコマンドで実行できる。

```bash
pnpm exec vitest run --config vitest.integration.config.ts packages/db/integration/safe-fetch.integration.test.ts
```

Hacker News item取得は最大4並列とし、一件失敗しても他itemを保存候補にできる。
全itemの通信が失敗した場合は成功した空feedとして扱わず、feed障害として報告する。
個々のitem失敗件数を新discovery metadataへ保存する経路は未実装。

## extract stageと固定入力

`createExtractStage()` はcandidate/discovery/job/environment/executor/configとarticleの
正規化URL・generation所属を照合する。HTTP本文で本文やURLを指定させない。
候補metadataの`summaryText`・`contentHtml`はZodでbyte上限を検査する。
metadataにgenerationIdがある候補はrequestのgenerationとの一致も必須とし、
旧snapshotで参照がない場合のみarticle所属による従来の認可を維持する。
generationへのjoinはdiscovery側で行い、extractは既存generation参照を受け取る。

追加migration `0008_safe_pepper_potts.sql` の `collector_extraction_inputs` に、
最初の認可済み候補のURL/fallback/chunker設定/hashをgeneration単位で固定する。
別feed/jobの候補は毎回所属を認可し、同generationの固定入力とoperationを使う。
別候補のfallbackで成功結果を書き換えない。chunker設定変更にはconfig version変更が必要。
inputのhash不一致は拒否し、参照中のcandidateをcleanupで削除しない。

operation claim後にtransaction外でReadabilityを実行する。本文/chunk/manifest/result/
operationは既存の原子保存を使う。空本文や64chunk超過は固定error codeで失敗を保存し、
部分payloadを残さない。成功後のHTTP応答喪失は同keyのreplayで回復する。
invocation中断後はfallbackを成功commitしない。期限切れの未送信operationの再claimは
既存lease policyに従う。本文取得はGemini apiAttemptを消費しない。

`extract.integration.test.ts` は実PGと署名付きHTTPで上記を検証する。
discoveryによるmetadata/generation作成は実装済み。CFが制御requestのoperation keyを作る
入力hash/keyはprepare HTTPで解決できる。CF controlの呼出しとCron→公開試験は未完了。

## discovery stageと候補snapshot

`createDiscoveryStage()` は固定configのfeed IDを解決し、HTTPからURLやモデルを指定させない。
環境/feed/UTC時刻slotの予約はPG advisory transaction lockとunique制約で直列化する。
同slotの別job、maxItems/config/executor等の入力変更は409。同operationの成功を再利用し、
同時実行中ならrunningを返して二重のfeed取得を防ぐ。feed取得はtransaction外で行う。

`0009_round_calypso.sql` はdiscoveryのnullable `feed_job_id`、
`0010_cynical_lockheed.sql` はnullable `input_hash` を追加する。
既存discoveryを新入力のものと推測しない。集計用crawl jobはCF job単位で共有し、
各feedのcrawl jobはsource/feed endpointに対応させる。feed障害でも予約と集計先を残し、
別feedを続行できる。feed jobの最終article集計はCF terminal投影の接続時に実装する。

候補は最大100件。ZodでURL/title/fallback/metricsを検証し、正規化URLで重複を除く。
無効な個別入力は除外する。article/generation/candidate/manifest/result/operation成功の保存は
同じtransaction。公開済みarticleは本文/titleを保護してmetricsのみ更新する。
別feedは同じ未完了generationにjoinし、fallbackとmetricsは候補metadataに保持する。
既存generationのversion不一致は候補単位のfailedとし、他の候補を止めない。

`0011_demonic_bill_hollister.sql` はcandidate dispositionのcheckへ`failed`を追加する。
candidate manifestは既存v1のフィールドに任意のgenerationId/feedJobId/errorCodeを追加し、
新discoveryではprocess候補にgeneration参照、全候補にfeed job参照、failed候補に固定errorを
返す。PGでは参照の環境・article・metadata所属を照合する。既存snapshotは従来の形で読める。
旧consumerに新dispositionを送らないexecutor/config切替とstaging受入は未完了。

discovery単体の再利用・障害・競合・rollbackは実PG試験済み。
全feed fatalからのCF job確定、feed毎の失敗件数・terminal集計、
Vercel入口への接続、D1/Workflow、実HTTP全体試験は未完了。

## 要約stageとgate経由の共通送信

`createSummarizeChunkStage()` はgeneration/chunkをPGから読み、候補のjob・環境・
executor/config/prompt/schema version所属と本文hashを検査する。任意のモデルやpromptを
HTTPから受け取らない。単一chunkは最終summary、複数chunkは部分要約を作る。
promptは資料・JSON schema・出力指示をまとめた固定入力で、生成とtoken計測へ同じ内容を渡す。
入力hashはprompt/出力種別/output token上限/count versionを含める。

`runGenerationOperation()` は以下の順に処理する。

1. generation/operation claim。成功結果は再利用し、uncertainは別モデルでも送信停止。
2. 完全promptのtoken計測。失敗したらwaitingとし、文字数推定で送信しない。
3. 入力tokenの1.1倍を切り上げてgate reserve。quota waitingはPG apiAttemptを増やさない。
4. 有効permitをconsume。期限切れ、所属不一致、consume応答不明は生成しない。
5. PGにmarkSentをcommitしてからgenerateを1回だけ呼ぶ。PG保存不明時には送信しない。
6. Zodでoutput/usageを検証し、result/attempt/operationを原子保存してgateへreportする。

token計測・gateは各10秒、generateは180秒のAbortSignalを伝播する。
Promise raceで停止したふりをせず、transportがsettleするまで待つ。transportが有効結果を
遅れて返した場合はPG lease/epochが有効な間だけ成功commitを試みる。
送信記録のPG commit後にもpermit期限と中断を検査する。generateをまだ呼んでいないことが
確定している場合だけ、fence付きtransactionで未送信markerを撤回してwaitingへ戻す。
apiAttemptは増やさず、新reservation generationで再予約する。markSent応答不明やAPI送信後は
この撤回を使わずuncertainとして扱う。
SDK adapterの中断伝播・隠れたretry無効化は実SDK/local HTTPで検証済み。
実サービス側のキャンセル保証や課金停止を意味しない。

429はrate_limited attemptとwaitingを記録し、同operationに最大3回まで新permitで送れる。
即時の内側retryは行わない。既知の拒否・不正outputはterminal failed、network等の送信不明は
uncertainとする。保存commitの応答喪失はPG statusを照会し、確定成功を優先する。
成功後のgate report障害でPG成功を失敗へ戻さない。gateは安全側に予約を保持し、
report確定漏れを回復するreconcilerは未実装。

gateのreserved/consumed/reported/waiting応答はstrict schemaを追加した。
reservationGenerationにはoperation lease epochを使い、quota待機後の再予約を
API送信attemptの増加と混同しない。count/quota versionは送信attemptへ保存する。
token countのモデル/input hash単位の保存・再利用は未実装。

署名付きHTTP gate clientとGemini SDK adapterは実装済みだが、stage runtime factoryとの
一体接続と全stage routerは実装済み。Vercel APIファイルも接続済み。CF DOは未実装。
共通送信とchunk stageの実PG試験合格を実Gemini送信・DO runtime検証と扱わない。

## 順序付きresult manifestとmerge

`MergeInputRepository.createOrdered()` は認可済みgenerationの全chunkについて、
同じprompt/schema version・許可モデルの成功resultがそろったことを確認する。
chunk index順に結果を選び、最初に成功した結果を保持する。モデルはprimary/fallback混在を
許容し、混在時の品質はstaging受入対象。未成功chunkの穴を埋める要約を生成しない。

snapshotは環境・generation・順序付きresult参照/hashから決定したUUIDv8を使い、
同じ内容を再登録しても増えない。PG generation lockの内側で参照を固定し、本文はCFへ
返さない。readはmanifest hash、件数、連続index、resultの環境/generation/chunk所属、
成功状態、version、モデル、output hashを再検査する。
chunk要約とmergeの両方で、本文/chunk順序を含む抽出snapshot全体のhashも検査する。

`createMergeSummaryStage()` は順序付き部分要約を完全promptにまとめ、同じ共通送信処理で
最終summaryを保存する。operation identityはmanifest IDだけでなく順序付きresult hashに
結び付ける。promptは最大2MiBで、超過時は送信しない。
成功chunkを再生成せず、既知のmerge拒否後は統合だけを別モデルoperationへ切り替えられる。
uncertainの自動fallbackは共通generation leaseで拒否する。

`merge.integration.test.ts` は3chunkの順序、欠落拒否、固定snapshot再利用、参照/順序改変、
統合replay、統合だけのfallback、persistによる公開記事/旧JSON互換まで実PGで確認する。
この試験はstage serviceを直接接続し、Gemini/gateにfixtureを注入する。
result manifest作成のprepare入口と全stageの署名HTTP連続試験は実装済み。DO runtime、
Webの保存記事表示、staging受入は引き続き未完了。

## Node→gate HTTP clientとGemini SDK adapter

`createGateClient()` は方向別HMACでreserve/consume/reportを署名する。
request ID/nonceは毎回新規。key、環境、executor、key IDを構築時にコピーする。
本番はHTTPS origin、ローカル試験はloopback HTTPを使用する。認証情報/query/path付き
originを拒否し、redirectは追わない。Cookieを送らず、自動HTTP retryを設けない。
要求16KiB、応答32KiB、全要求10秒上限。stream body読出しにもAbortSignalを適用し、
応答schemaを検証する。HTTP/JSON/transport errorは固定codeへ変換する。

`gate-client.integration.test.ts` はnative HTTPと実HMAC/nonce消費fixtureで3操作を確認し、
redirect先未到達、巨大応答拒否、停止通信の中断を検証する。D1 nonce/DOの代替試験ではない。

`createGeminiGenerationAdapter()` は `@google/genai` のcountTokens/generateContentを使う。
[公式retry設定](https://googleapis.github.io/js-genai/release_docs/interfaces/types.HttpRetryOptions.html)の
attemptsを1に固定し、countは10秒、generateは180秒のtimeout/AbortSignalを渡す。
promptは同一内容。schemaをpromptへ含め、SDKではJSON MIME・candidate 1・output token上限と
automatic function calling無効を指定する。429は既知rate limit、400/401/403/404/422は
既知拒否、network/5xx等は送信不明として共通処理へ渡す。

usageはprompt/total tokenから求め、thinking tokenもoutput側に含める。
STOPした単一candidateのtextだけを読み、thinkingを除き、非text partと64KiB超過textを
不正出力として扱う。SDKのtext convenience getterの警告出力は使わない。
不正JSONでもAPI応答が確定していればterminal output failureとし、取得できたusageを
PGのfailed attemptへ保存してgateへreportする。raw body/SDK errorをlogに出さない。

`apps/collector/integration/gemini-adapter.integration.test.ts` は実SDKをdummy keyで
loopback fixtureへ接続し、同一prompt、usage、429/503のAPI呼出一回、中断、不正JSONを検証する。
Google実APIへは接続しない。SDK応答はSDKが先にparseするため、raw HTTP responseのbyte制限は
未実装。インストール済みSDKには最新docsの`HttpOptions.fetch`がなく、対応版のPoC/固定installか
別の実transport制限が必要。text制限だけでraw responseのmemory上限を保証しない。

## Node runtimeとprepare API

`createNodeRuntime()` はdiscovery/extract/summarize-chunk/merge-summary/persist/job-finalizeを
同じHTTP handlerへ接続する。共通の環境・executor/config/prompt/schema versionを使い、
PG nonce消費、success replay、manifest/status読出しも同じruntimeで処理する。
既定の要約依存はGemini SDK adapterと署名gate client。feed/SDK依存注入はローカルfixture用で、
本番向けの署名を省略する設定や試験endpointは追加しない。

`POST /api/v1/prepare` はoperationKeyを含まないstrict stage参照を受け取り、認可済みPG入力と
固定configからoperationKey/inputHashを解決する。generation参照と、必要ならordered result
manifest IDだけを返す。本文・prompt・要約textは返さない。mergeではmanifest IDを省略して
全成功chunkのsnapshot作成を依頼できる。実行は従来の各stage POSTで行う。
prepareはHMAC/nonce/環境/executor/config/16KiB/32KiB制限を共有し、期限切れを処理前に拒否する。
抽出入力固定やresult manifest作成を行うが、feed取得・token計測・generate・公開は行わない。

この追加APIはCFがPG内部本文を持たずにkeyを作るための参照解決手順。
CF Workflowの外部request予算・step予算と費用にはprepare呼出しも計上する。
古いdeploymentへのroute/保持とAPI互換はstaging受入で確認する。

`apps/collector/integration/runtime.integration.test.ts` は同じnative Node adapter、実PG、
実Google SDK→local架空API、Node→gate実HMAC HTTP、CF→Node実HMAC HTTPを接続する。
長文3chunkはdiscovery→extract→chunk→merge→persist→finalize、単一chunkのfeed fallbackは
mergeなしで公開する。生成/計測/permit数、公開状態、旧要約JSON、集計、期限切れ成功replay、
別jobのprepare拒否をassertする。feed取得は注入fixtureで、実外部feedを呼ばない。

Vercel APIファイル・ENV config・credentialなしbundleは実装済み。
CF Cron/Queue/D1/DO/Workflowを含む全体試験、Vercel platform build、SDK raw response byte制限、
実Next.js/Playwright、IaC/Actions、staging受入は未完了。
Node runtime試験の合格をCF→公開の全体受入完了とは扱わない。

## 構造化ログとSlack障害通知

Node API共通handlerはJSON Linesを標準出力へ出す。`timestamp`（UTC）、`level`、
`service=collector`、`event`、`environment`、`requestId`を基準に検索する。
認証・契約検査済みstageでは`jobId`、`workId`、`operationKey`、`generationId`、
`stage`、`executorVersion`、`configVersion`、`apiAttempt`も記録する（該当する項目のみ）。
開始、完了、保存済み結果のreplay、待機理由・`nextEligibleAt`、所要時間、HTTP障害、
job確定時のfailed/cancelled件数を記録する。GET operation-statusのuncertainも記録する。
PG/通信障害は既知のdriver codeを`causeCode`へ分類する。
生の例外、stack、SQL、DB URL、署名、記事URL、本文、prompt、LLM出力はログ・通知へ渡さない。

`apps/collector/.env.example`の次の2変数をcollectorのローカル`.env`またはVercelの
環境別secret設定へ追加する。ローカルNode実行では`.env`を起動時に読み込む
（例: `node --env-file=apps/collector/.env <entrypoint>`）。値はcommitしない。

- `SLACK_BOT_TOKEN`: Slack AppのBot User OAuth Token（`xoxb-...`）。署名用Signing Secretとは異なる。
- `SLACK_CHANNEL_ID`: 通知先channel ID（`C...` / `G...`）。チャンネル名ではなくIDを使う。

Botに`chat:write`を付与し、通知先の部屋へ招待する。
[`chat.postMessage`公式仕様](https://docs.slack.dev/reference/methods/chat.postMessage/)に従い、
固定のSlack APIへBearer認証でJSON送信する。両方空ならSlack通知を無効にし、ログは継続する。
片方だけ、または不正な形式の設定は`SLACK_CONFIGURATION_INVALID`をログへ残し、
バッチ処理は継続する。secret変更後は新しいruntime instanceへ反映させる。

通知対象はHTTP 5xx、実行deadline超過、stageのfailed、送信結果不明、
Node初期化・設定障害、token count/gate接続障害の待機、gateへの結果報告失敗、
job確定時の部分失敗・cancelled。成功、通常のquota/429待機、running、意図的なNode無効化、
認証不備や通常の入力競合はログのみ。HTTP 200の業務エラーも通知する。
通知には追跡ID・原因コードと初動の確認手順を含める。

1. 通知の`requestId`でVercelログを検索し、`stage`・`causeCode`・versionを確認する。
2. 制御側の認証付きoperation-status照会とPGのoperation/generation/attempt/resultを照合する。
3. 成功済みresultは再利用する。waitingは`nextEligibleAt`と制御側のretry方針に従う。
4. `GENERATION_OUTCOME_UNKNOWN`など送信不明は自動再送せず、送信・保存記録を確認する。
   manual resume入口は未実装。SQLで状態を一括resetしない。
5. job部分失敗はfailed/cancelled workと保存済みresult、確定集計を照合する。

送信は応答前にawaitし、3秒のtimeoutを設定する。通知失敗は元のHTTP結果・PG状態を変更せず、
`slack_notification_failed`を出す。429時は`Retry-After`（最大1時間）まで同一instanceの
送信を抑制する。即時retryは行わない。同一operation/原因の通知は同一instanceで5分抑制し、
履歴は最大1000件・同時送信は最大4件。抑制中も元の障害ログは毎回残る。
異なるVercel instance間の重複排除・Slackへの永続再配送は保証しない。
これは移行先Node処理の第一報であり、未実装のCF Workflow/Queue/DLQ/reconcilerや
process強制終了・Function自体が起動しない障害は対象外。現行Trigger.devの通知経路は変更しない。
CF制御側の実装時には同じ識別子でDLQ・retry枯渇・stalled job検知を接続する。
