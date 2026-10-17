# ニュース要約アプリ IndexedDB実装計画書

## 概要

MVPではユーザー認証を導入せず、IndexedDB(Dexie.js)で既読・保存・閲覧位置を管理する。

### 保存対象
- Saved記事
- 既読記事
- 最後に閲覧した記事位置
- UI設定

## 技術選定

- React
- TypeScript
- Dexie.js
- IndexedDB

## IndexedDBテーブル

### saved_articles
```ts
{
  articleId: string;
  savedAt: string;
}
```

### read_articles
```ts
{
  articleId: string;
  readAt: string;
}
```

### reading_progress
```ts
{
  feedType: string;
  articleId: string;
  updatedAt: string;
}
```

### app_settings
```ts
{
  key: string;
  value: string;
}
```

## 既読判定

- 記事表示後1秒以上滞在。記事移動時に計測をやり直し、閲覧位置・保存状態・他の記事の既読更新では計測をリセットしない。
- または詳細画面表示

## UI方針

### 未読
- 青丸
- 太字タイトル

### 既読
- グレー表示
- 通常文字

### Saved
- ★アイコン表示

## 一巡後の体験

```txt
🎉 今日の新着は以上です

今週の人気記事
AIまとめ
おすすめ記事
```

## セキュリティ

### 保存してよいもの
- 記事ID
- 既読状態
- Saved状態
- UI設定
- 閲覧位置

### 保存禁止
- APIキー
- JWT
- OAuthトークン
- 個人情報

## 将来拡張

### Phase2
- Googleログイン
- 既読同期
- Saved同期

### Phase3
- 複数端末同期

### Phase4
- 全文検索
- ローカルRAG
- SQLite WASM検討
