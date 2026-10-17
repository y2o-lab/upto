# Storymesh のUI状態スペック

## 導入

- 本体: npm の `storymesh@0.1.0` をルートの開発依存に固定。
- 公式skill: `y2o-lab/storymesh` の `skills/storymesh/SKILL.md` を `.agents/skills/storymesh/SKILL.md` に導入。skillはnpm本体とは別配布で、次のターンから利用できる。
- スペック: `.storymesh/specs/*.yaml`。実際に生成したStorybook indexを `spec import` で取り込み、必要な状態を追記したレビュー案。

初回は `pnpm install --frozen-lockfile` を実行する。

## スペックの範囲

| Storybook title | 対象 | 必須状態 |
| --- | --- | --- |
| `Pages/Home` | `/` | 通常、空、初回読み込み、初回取得失敗 |
| `Pages/Bookmarks` | `/bookmarks` | 通常、空、保存記事読み込み、保存記事取得失敗 |
| `Components/ArticleFeed` | 共通フィード | 通常、追加取得中、追加取得失敗、完了、空、長文、保存済み、既読 |

各状態の期待表示はYAMLのコメントに記載する。ホームの読み込み・エラーはApp Routerの `loading.tsx` / `error.tsx` 相当の表示を対象にする。現在のページstoryは固定データのプレビューであり、ページ本体のDB取得や保存記事の通信処理まで検証するものではない。

小さい内部コンポーネントのstoriesは一律には要求しない（ADR-0003）。レイアウトやThemeToggle単体のstoryも今回のスペック対象外。ライト・ダーク、モバイル・デスクトップでの表示確認は、上記の状態と組み合わせて行う。

## 確認コマンド

```bash
# ファイル単位の現状を一覧する。欠落があっても終了コード0。
pnpm storymesh:report

# 現在のcheckoutからindexを生成し直して、必須状態の登録を照合する。
pnpm storymesh:check
```

`storymesh:check` は毎回 `apps/web/storybook-static/index.json` を更新する。indexは生成物としてGit管理しない。終了コードは0が必須story登録済み、1が必須story不足、2が入力や実行のエラー。未宣言storyは警告になる。

今回はスペックのレビューが先のため、未作成の状態も `required: true` として宣言している。**終了コード1は不足を可視化する想定結果**。承認後にstoryを実装して解消する。既存の `pnpm verify` やCIにはまだこのチェックを組み込まない。

## レビュー・実装時の注意

- `component.title` はStorybookのtitleと完全一致させる。
- storyのIDはindex内の表示名を小文字にし、空白・`_`・`-` の連続を `-` に変換した値。例: `Loading More` → `loading-more`。
- `spec check` はstoryの登録のみを検証する。YAMLコメントの表示条件、描画、操作結果が正しいことまでは検証しない。
- 保存・既読・閲覧位置・テーマはIndexedDBに残るため、story実装時は状態を明示的に初期化し、他のstoryや閲覧履歴に依存させない。
- 縦スワイプ、ホイールの1記事移動、Up/Down/Space/Shift+Space、保存ボタン上のSpace操作はPlaywright等で確認する。
- 長文状態はモバイルでもタイトル・要点・重要性・元記事リンクが読めること、両テーマでコントラストとフォーカスが保たれることを確認する。
- storyの自動生成は行っていない。スペック承認後も空の骨組みだけで要件を満たした扱いにしない。

設計上の根拠は `DESIGN.md`、ADR-0003、`docs/news-summary-batch-db-design-v2.md`、`docs/indexeddb-implementation-plan.md`。技術選定や画面フローを変更する決定は含めない。
