# ADR-0005: 同一サーバー上の CLI による Trigger.dev task デプロイ

日付: 2026-08-08
ステータス: Accepted

## 背景

Upto の Coolify、セルフホスト版 Trigger.dev、開発環境は単一のオンプレサーバーで運用する。ADR-0004 で定めた Coolify deploy resource と分離した remote Docker executor を使う経路は、この構成では追加の VM、mTLS 証明書、secret mount を必要とし、初期運用に対して過剰である。

## 決定

Trigger.dev task のデプロイは、Coolify と Trigger.dev を稼働させているサーバー上で、運用者が `apps/collector/scripts/deploy-trigger.sh` を実行して行う。script はそのサーバーのローカル Docker daemon を使い、GHCR へ task image を push した後、Trigger.dev API へ deployment を登録する。

Coolify は Trigger.dev 本体の運用に利用するが、collector task の deploy resource や post-deployment command には利用しない。GitHub への merge は deployment を自動実行せず、検証済みの commit を運用者が staging、次に production へ明示的に deploy する。

## 理由

- 既存の単一サーバー構成で、追加の remote executor と Docker mTLS 証明書管理を不要にできる
- task image の build、registry push、Trigger.dev deployment 登録を既存の CLI script に集約できる
- staging と production の切替を `TRIGGER_DEPLOY_ENV` と明示コマンドで確認できる

## 影響

- deploy 権限を持つサーバー上の運用アカウント、およびその環境変数はローカル Docker daemon を操作できる。サーバーへの管理アクセス、`.env` の権限、GHCR PAT を厳格に管理する。
- Docker socket を Coolify container へ mount しない。deploy script は Coolify deploy resource 内では実行しない。
- Docker daemon が停止した場合、task deployment は失敗するが、すでに登録済みの Trigger.dev deployment の実行管理は Trigger.dev が継続する。
- ADR-0004 の task deployment 経路を置き換える。Trigger.dev による schedule、ログ、実行履歴、再実行の管理は維持する。

## 代替案

- 分離した remote Docker executor: 権限分離を強められるが、単一サーバーの初期運用には VM と mTLS 証明書管理が必要になるため採用しない。
- Coolify deploy resource に host Docker socket を mount: 実装は簡単だが、container に host Docker の強い権限を渡すため採用しない。

## 追記

- 2026-08-08: 初版作成。ADR-0004 の task deployment 経路を置き換える。
