# ADR-0004: Trigger.dev と Coolify によるバッチのデプロイ・実行管理

日付: 2026-06-20
ステータス: Accepted

## 背景

ADR-0001 では、バッチ処理をオンプレ Ubuntu Server にデプロイし、Docker Compose と systemd timer で定期実行する方針を採用した。

その後、オンプレ環境の Coolify 上にセルフホスト版 Trigger.dev を構築した。バッチのスケジュール、ログ、実行履歴、手動での再実行を個別の systemd 設定やホスト上のコマンドで管理せず、Trigger.dev に集約する。

また、バッチ本体の継続的なデプロイには、既にオンプレ環境で利用している Coolify と GitHub の連携を利用する。

## 決定

バッチはオンプレ環境にデプロイする。バッチのスケジュール、ログ確認、実行履歴、および再実行は、Coolify 上で稼働するセルフホスト版 Trigger.dev で管理する。systemd timer はバッチのスケジューラーおよび実行管理には使用しない。

バッチ本体も Coolify でデプロイし、Trigger.dev から実行される構成とする。デプロイ経路は以下とする。

1. Coolify で GitHub リポジトリをリソースとして登録する。
2. 対象ブランチへの変更を GitHub webhook で Coolify に通知する。
3. Coolify がバッチ本体のコンテナイメージをビルドしてデプロイする。
4. セルフホスト版 Trigger.dev が、デプロイされたバッチをスケジュールまたは手動操作で実行する。

Coolify からバッチ本体をビルドできるように、pnpm workspace 内の `apps/collector` と、その実行に必要な workspace package を含めたコンテナイメージを作成する Dockerfile をリポジトリに置く。Dockerfile は本番実行に不要な開発依存やソースを可能な範囲で最終イメージから除外し、Trigger.dev からの実行に必要な起動方法を明示する。

データベース接続文字列、Gemini API キー、Trigger.dev の認証情報などの秘密情報は Dockerfile やイメージに含めず、Coolify または Trigger.dev の環境変数・secret 管理から実行時に注入する。

## 理由

- スケジュール、ログ、実行履歴、再実行を Trigger.dev の管理画面に集約できる
- オンプレ運用を維持しつつ、systemd unit、timer、journald をまたぐバッチ運用を減らせる
- Coolify と GitHub webhook にデプロイ経路を統一し、対象ブランチの更新をバッチ環境へ反映できる
- Dockerfile をデプロイ単位にすることで、ローカル環境とオンプレ実行環境の差を抑えられる
- セルフホスト済みの Trigger.dev と Coolify を利用するため、新たな外部バッチ実行基盤を増やさずに済む

## 影響

- ADR-0001 の「Docker Compose + systemd timer によるバッチのデプロイ・実行・ログ管理」は本 ADR で置き換える
- `apps/collector` の変更時は、Coolify で再現可能にビルドできる Dockerfile を保守する必要がある
- GitHub webhook、Coolify の対象ブランチ・ビルド設定、Trigger.dev の実行設定を運用対象とする
- Trigger.dev または Coolify が停止すると、バッチのスケジュール実行、デプロイ、ログ確認、再実行に影響するため、両サービスの永続データ、バックアップ、死活監視を別途整備する必要がある
- webhook の受信だけで未検証の変更を本番デプロイしないよう、デプロイ対象ブランチの保護と CI の成功をデプロイ条件にする
- バッチは引き続き冪等に実装し、再実行によって記事やジョブ状態が不整合にならないようにする

## 代替案

- Docker Compose + systemd timer: ホスト標準機能で構成できるが、スケジュール、ログ、実行履歴、再実行の管理が分散するため採用しない
- Trigger.dev Cloud: 運用負荷は下げられるが、バッチ実行基盤をオンプレに置く方針と、構築済みのセルフホスト環境を優先するため採用しない
- GitHub Actions の scheduled workflow: GitHub 側に実行基盤と履歴が分かれ、オンプレ上の Trigger.dev に運用を集約できないため採用しない

## 追記

- 2026-06-20: 初版作成。オンプレの Coolify とセルフホスト版 Trigger.dev によるバッチのデプロイ・実行管理を Accepted として記録。
