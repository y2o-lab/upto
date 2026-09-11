# ADR-0007: Session pooler と CA 検証による release migration

日付: 2026-09-12
ステータス: Accepted

## 背景

ADR-0006ではmigration用接続をDirectとしていたが、GitHub ActionsのIPv4環境ではSupabaseの標準IPv6 Direct endpointへ到達できない。Session poolerへ切り替えた実行では、Node.jsが接続先の証明書チェーンを信頼できず`SELF_SIGNED_CERT_IN_CHAIN`で失敗した。

## 決定

GitHub Actionsのrelease migrationにはSupabase Shared PoolerのSession mode（port `5432`）を使用する。到達可能なDirect connectionも利用可能とし、Transaction modeは使用しない。既存のSecret名`DIRECT_DATABASE_URL`は互換性のため維持し、URIに`sslmode=verify-full`を指定する。

`production-release` Environmentに`DATABASE_SSL_CA`としてSupabase CA証明書のPEM全文を登録する。workflowがrunnerの一時ファイルに保存し、`NODE_EXTRA_CA_CERTS`を通じて接続診断とDrizzle Kitの両方へ渡す。CA未設定・不正な証明書ではmigrationを開始しない。証明書検証は無効化しない。

## 理由

Session modeはIPv4とセッション状態の維持に対応し、現在のDrizzle migrationを実行できる。CAを明示的に信頼させることで、TLS証明書と接続先ホスト名の検証を維持する。

## 影響

ADR-0006のDirect専用という接続方針を置き換える。検証、migration、Web deploymentの順序と失敗時の停止は維持する。運用手順は[Supabase接続デプロイ手順書](../supabase-deployment-runbook.md)に記載する。

## 代替案

- IPv4 add-onまたはIPv6対応runnerでDirect接続を使用する: 利用可能だが、今回のSession poolerによる運用では不要。
- TLS証明書検証を無効化する: 接続先の真正性を検証できなくなるため不採用。

## 追記

- 2026-09-12: 初版作成。
