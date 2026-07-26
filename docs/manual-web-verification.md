# Webアプリ手動検証手順

作成日: 2026-06-07

この手順は Next.js WebアプリがPostgreSQLの要約済み記事を表示し、モバイル縦スワイプ、PCホイール、キーボード操作で記事を閲覧できることを手動確認するためのものです。

## 前提

- Node.js 24 LTS
- pnpm 10.8.1 以上
- `.env` が作成済み
- `DATABASE_URL` が `.env` に設定済み
- DB migration 適用済み
- collector batch により `article_summaries` まで保存された記事がある

記事がまだない場合は、先に `docs/manual-batch-verification.md` を実施してください。

## 1. 依存関係を準備する

```bash
pnpm install
```

## 2. PostgreSQLを起動する

ローカルDBで確認する場合:

```bash
docker compose up -d postgres
docker compose ps
```

期待結果:

- `postgres` service が `running` または `healthy` になる

外部DBで確認する場合:

- `.env` の `DATABASE_URL` が対象DBを指していることを確認する
- 接続先DBにmigrationが適用済みであることを確認する

Supabase本番検証では、Vercelの`DATABASE_URL`にTransaction pooler（port 6543）、`DATABASE_POOL_MAX=2`を設定する。migrationは同じURLを使わず、Direct connectionを`DIRECT_DATABASE_URL`へ設定して実行する。いずれの値も`NEXT_PUBLIC_`変数には設定しない。

## 3. 開発サーバーを起動する

```bash
pnpm dev:web
```

期待結果:

- `http://localhost:3000` が表示される
- Next.js dev server がエラーなく起動する

## 4. ブラウザで初期表示を確認する

ブラウザで以下を開きます。

```txt
http://localhost:3000
```

期待結果:

- ヘッダーに `Upto` と `日本語ITニュース要約` が表示される
- 記事カードが1枚ずつ読める
- source名、難易度、公開日時、タイトル、1行要約、本文要約、箇条書き、タグ、score、bookmarks が表示される
- `元記事を読む` リンクが表示される
- 画面右上のカウンターが `1 / 記事数` の形式で表示される

## 5. 空状態を確認する

要約済み記事がないDB、または一時的に空のローカルDBへ接続して起動します。

期待結果:

- `まだ表示できる記事がありません` が表示される
- collector batch 実行を促す説明が表示される
- 画面が崩れない
- エラー画面にならない

## 6. PC操作を確認する

デスクトップ幅で `http://localhost:3000` を開きます。

確認項目:

- マウスホイールを下方向に動かすと次の記事へ移動する
- トラックパッドで下方向へスクロールすると次の記事へ移動する
- 大きく連続スクロールしても一気に複数枚飛びすぎない
- 上方向スクロールで前の記事へ戻れる
- カードの本文やボタンがヘッダーに隠れない
- 横幅を狭めてもテキストがはみ出さない

## 7. キーボード操作を確認する

ブラウザでページを開いた状態で、以下を確認します。

| 操作 | 期待結果 |
|---|---|
| `ArrowDown` | 次の記事へ移動する |
| `Space` | 次の記事へ移動する |
| `ArrowUp` | 前の記事へ移動する |
| `Shift + Space` | 前の記事へ移動する |

確認観点:

- 画面右上のカウンターが記事移動に合わせて更新される
- 移動後の記事タイトルが画面内に入る
- 最初の記事で前へ戻ろうとしても壊れない
- 最後の記事で次へ進むボタンを押すと先頭へ戻る

## 8. モバイル表示を確認する

ブラウザの開発者ツールでモバイル幅にします。目安:

- iPhone系: 390 x 844
- Android系: 412 x 915

確認項目:

- 1記事カードが縦方向に読みやすい
- 上下スワイプで記事が1枚ずつ切り替わる
- タイトル、要約、箇条書き、タグ、CTAが画面幅からはみ出さない
- `元記事を読む` と `次の記事へ` が押しやすい
- ヘッダーとカード内容が重ならない

## 9. 元記事リンクを確認する

各記事カードで `元記事を読む` をクリックします。

期待結果:

- 新しいタブで元記事URLが開く
- Webアプリ側のタブはそのまま残る
- `rel="noreferrer"` のため、不要なreferrerを送らない

## 10. エラー状態を確認する

一時的に `DATABASE_URL` を無効な値にして `pnpm dev:web` を起動します。

期待結果:

- `記事を読み込めませんでした` が表示される
- DB接続または環境変数確認を促す説明が表示される
- `再読み込み` ボタンが表示される

確認後は `.env` を正しい値に戻してください。

## 11. 本番ビルドを確認する

```bash
pnpm --filter @upto/web build
```

期待結果:

- build が成功する
- `/` が Dynamic route として表示される

## 12. 自動E2Eも併用する

```bash
pnpm exec playwright install chromium
pnpm exec playwright test
```

期待結果:

- desktop と mobile のfeed表示テストが成功する
- keyboard navigation テストが成功する

Playwrightでは `UPTO_WEB_USE_FIXTURE_DATA=true` を使い、DB状態に依存しない固定データで検証します。通常の `pnpm dev:web` と本番運用では `DATABASE_URL` の実DBを読みます。

## 13. 後片付け

Web開発サーバー停止:

```txt
Ctrl+C
```

ローカルPostgreSQLを止める場合:

```bash
docker compose stop postgres
```

ローカルDBデータも消す場合:

```bash
docker compose down -v
```

`down -v` はローカルDBデータを削除します。本番や共有DBでは実行しないでください。

## 失敗時の確認ポイント

- `.env` の `DATABASE_URL` が正しいか
- DB migration が適用済みか
- `article_summaries` に要約済み記事が存在するか
- collector batch が `COLLECTOR_DRY_RUN=false` で実行されているか
- `pnpm --filter @upto/web build` が成功するか
- ブラウザコンソールにhydration errorやruntime errorが出ていないか
