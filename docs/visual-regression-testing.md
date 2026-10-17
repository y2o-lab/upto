# VRTの実行と基準画像の更新

VRTは現在のUIを基準画像にして、意図しない表示変更を検出する。既存の操作E2Eとは別に実行し、PR・main・releaseの品質ゲートに含める。

## 対象と固定条件

- フィード、保存一覧、保存一覧の空状態・読み込み中・エラー状態、フィード末尾。
- デスクトップ（1280 × 800）とPixel 7（412 × 839 CSS px）、それぞれライト／ダーク。
- DBを使わない既存fixture、ブラウザ時刻、ja-JP、Asia/Tokyo、初期ストレージを固定。既読化タイマーを停止し、必要な描画フレームだけ進める。
- アニメーションを停止し、フォントの読み込みと画面の準備完了を待つ。外部へのブラウザ通信を遮断する。
- 本番ビルドを使用し、Next.jsの開発用インジケーターを撮影しない。
- Playwright 1.63.0公式イメージのLinux amd64で生成・比較する。Macの描画結果は基準画像にしない。Dockerソケットやローカルの環境変数ファイルはコンテナへ渡さない。

設定は`playwright.visual.config.ts`、テストと基準画像は`apps/web/e2e/visual/`に置く。通常の`pnpm test:e2e`からはVRTを除外する。

## 実行

Dockerを起動し、リポジトリルートで実行する。

```bash
pnpm test:vrt
```

初回はイメージ取得と依存インストール・本番ビルドが必要。以降はDockerのビルドキャッシュを使う。Apple Siliconでもamd64として実行するため、初回ビルドには時間がかかる。

比較は基準画像を自動更新しない。差分や基準画像の欠落で失敗し、HTMLレポートは`playwright-report/visual/`、期待画像・実画像・差分画像・トレースは`test-results/visual/`へ出力する。

```bash
pnpm exec playwright show-report playwright-report/visual
```

## 意図したUI変更

1. UI変更後に`pnpm test:vrt`を実行し、変更前・変更後・差分を確認する。モバイルやダークモードへの予期しない影響も確認する。
2. 不具合はコードで修正する。意図した変更だけ、対象テストに絞って基準画像を更新する。

   ```bash
   pnpm test:vrt:update --grep "news feed"
   ```

3. `apps/web/e2e/visual/snapshots/`の変更を画像で確認し、UIコードと同じPRに含める。PR本文に意図した表示変更を書く。
4. `pnpm test:vrt`を再実行し、更新した基準で成功することを確認する。レビュアーは基準画像の変更も確認する。

全画面を意図的に変更するときのみ、対象指定なしの`pnpm test:vrt:update`を使用する。差分が出たという理由だけで一括更新したり、CIで自動承認したりしない。許容差分を広げてレイアウト崩れを隠さない。

## CI

`web-e2e.yml`の`Visual regression`ジョブが同じDocker実行スクリプトを使用する。失敗時も`visual-regression-report`アーティファクトにレポートと差分を7日間保存する。

`verify.yml`の集約`verify`はVRTの失敗でも失敗する。`release-web.yml`も同じ再利用workflowに依存するため、VRTが失敗した場合は本番migration・deployを開始しない。マージを禁止するにはGitHub側で集約`verify`チェックを必須にしておく。

Playwrightを更新するときは、`package.json`とVRTのDockerfileのバージョン・イメージdigestを揃え、ブラウザやフォントの変更による差分を確認して基準を更新する。

参考: [Playwrightの画像比較](https://playwright.dev/docs/test-snapshots)、[Dockerでの実行](https://playwright.dev/docs/docker)。
