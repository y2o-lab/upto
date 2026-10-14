# Storymesh 導入手順（Upto）

Upto の React ページに対応する Storybook Story の抜け漏れを、[Storymesh](https://github.com/y2o-lab/storymesh) で確認するための手順です。コマンドは特に断りがなければリポジトリのルートで実行します。

## 対象と前提

- [AGENTS.md](../AGENTS.md) の方針では、新しい `apps/web/src/app/**/page.tsx` に同じディレクトリの `page.stories.tsx` が必要です。小さな内部コンポーネントの Story は任意です。
- Storybook は `apps/web/src/**/*.stories.*` を読み込みます（[設定](../apps/web/.storybook/main.ts)）。Storymesh はファイル名と配置から対応を調べます。Story の描画や操作が成功するかは検証しません。
- 開発環境は Node.js 24 と pnpm 10.8.1 以上です。`0.1.0-alpha.4` の npm 配布は macOS／Linux 向けで、Windows パッケージは提出対象から除外されています。Windows での実行は、この版では導入条件に含めないでください。
- npm の `latest` は初回ステージ公開時のプレースホルダーを指す可能性があるため、以下では公開済みの版を明示します。

## 1. 依存関係を追加する

Storymesh をワークスペースのルートに開発依存として追加します。`package.json` と `pnpm-lock.yaml` の変更を一緒にコミットしてください。

```bash
pnpm add -Dw storymesh@0.1.0-alpha.4
```

追加後、CLI の起動を確認します。

```bash
pnpm exec storymesh --version
```

期待値は `0.1.0-alpha.4` です。API キーやアプリの環境変数は不要です。

## 2. ページの Story を確認する

`apps/web/src/app` をスキャンし、現在ある Next.js の特殊ファイルを除外します。Storymesh は `.tsx` ファイルをコンポーネント候補とするため、`layout.tsx`、`error.tsx`、`loading.tsx` を除外しないとページの Story と無関係の警告が出ます。

```bash
pnpm exec storymesh check apps/web/src/app --framework react \
  --ignore '**/layout.tsx' \
  --ignore '**/error.tsx' \
  --ignore '**/loading.tsx'
```

この手順書を作成した時点では `page.tsx` が2件あり、どちらにも隣接する `page.stories.tsx` があるため、`All 2 React components have stories.` と表示されます。終了コード `0` は不足なし、`1` は Story の不足、`2` はパスや読み取りなどのエラーです。不足が出たら該当ページの隣に `page.stories.tsx` を追加し、再実行します。

## 3. 開発用コマンドと CI に組み込む

ルートの `package.json` の `scripts` に次を追加します。

```json
"storymesh:check": "storymesh check apps/web/src/app --framework react --ignore '**/layout.tsx' --ignore '**/error.tsx' --ignore '**/loading.tsx'"
```

同じファイルの `verify` スクリプトの末尾に `&& pnpm storymesh:check` を加えます。既存の [verify ワークフロー](../.github/workflows/verify.yml) は `pnpm install --frozen-lockfile` の後に `pnpm verify` を実行するため、ワークフローの変更なしで PR と `main` の両方を確認できます。

```bash
pnpm storymesh:check
pnpm verify
```

CI では `check` を使い、`--generate` は付けません。`--generate` は Story の雛形を書き込む開発用操作で、不足があっても生成に成功すれば終了コード `0` になります。

## 4. 任意の参考レポート

内部コンポーネントも把握したい場合は、CI の必須チェックとは別に次を実行します。

```bash
pnpm exec storymesh report apps/web/src/components --framework react
```

現状は3コンポーネント中1件に Story があり、`saved-articles-feed.tsx` と `theme-toggle.tsx` が不足として表示されます。これらの Story は現行方針では任意です。`report` は不足があっても終了コード `0` なので、導入後に対象範囲を広げるかどうかを判断する資料として使います。

Storymesh のチェックは Storybook ビルドを代替しません。Story の読み込みや描画を確認するときは、従来どおり `pnpm build-storybook` を実行してください。
