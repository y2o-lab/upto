# Codex harness

作成日: 2026-06-07

このリポジトリでは Codex を制御するためのハーネスを、公式 Codex manual の現行仕様に合わせて repo scope で管理する。

## 参照した公式仕様

- Codex manual: `https://developers.openai.com/codex/codex-manual.md`
- 取得結果: `codex-cli 0.137.0` の manual helper で current と確認
- 主要仕様:
  - `AGENTS.md` は Codex 起動時に global から project、current directory へ向けて読み込まれる
  - project `.codex/config.toml`、project hooks、project rules は trusted project でのみ読み込まれる
  - repo skills は `.agents/skills` から検出される
  - custom subagents は `.codex/agents/*.toml` で定義できる
  - hooks は `.codex/hooks.json` または config inline で定義できる
  - rules は active config layer の `rules/*.rules` から読み込まれる。rules は experimental 扱いのため、Codex 更新後は再検証する

## ファイル構成

```txt
AGENTS.md
.codex/
  config.toml
  hooks.json
  agents/
    architecture-reviewer.toml
    security-reviewer.toml
    test-planner.toml
  hooks/
    codex_hook_guard.py
    self_feedback.py
  rules/
    project.rules
.github/
  dependabot.yml
  ISSUE_TEMPLATE/
    harness-feedback.yml
.agents/
  skills/
    adr-maintainer/
      SKILL.md
    codex-harness-maintainer/
      SKILL.md
    news-summary-implementation-planner/
      SKILL.md
docs/
  codex-harness.md
```

## 制御面の役割

| 制御面 | 役割 |
|---|---|
| `AGENTS.md` | リポジトリの恒久的な作業規約、技術スタック、検証方針、レビュー観点 |
| `.codex/config.toml` | trusted project で使う Codex 既定値、sandbox、approval、hook 有効化、subagent 上限 |
| `.codex/rules/project.rules` | sandbox 外実行のコマンド判定。破壊的 git 操作、sudo、dependency 変更、push などを制限 |
| `.codex/hooks.json` | lifecycle hook の登録。`PostToolUse` で開発フロー不変条件を確認し、`Stop` で自己フィードバック検証を起動 |
| `.codex/hooks/codex_hook_guard.py` | prompt/command/permission request 内の秘密情報と明確に危険な command を検出 |
| `.codex/hooks/self_feedback.py` | worktree 変更に応じて開発フロー検査、`pnpm verify`、harness 検証を自動実行 |
| `.github/dependabot.yml` | npm/pnpm と GitHub Actions の定期アップデートPRを作成 |
| `.github/ISSUE_TEMPLATE/harness-feedback.yml` | 繰り返し発生した agent 違反やレビュー指摘を記録し、harness 昇格候補を管理 |
| `.agents/skills/*` | Codex が必要時に読み込む再利用ワークフロー |
| `.codex/agents/*` | 明示的に subagent を使うときの専門 agent |

## Trust and activation

project `.codex/` layer は Codex がこの repository を trusted と判断した場合だけ読み込まれる。初回または hook 変更後は Codex CLI で `/hooks` を開き、表示された hook 定義を確認して trust する。

skills は repo scope の `.agents/skills` に置いているため、Codex の skill discovery 対象になる。skill が見えない場合は Codex を再起動する。

subagents は自動では起動しない。使う場合は、たとえば次のように明示する。

```text
architecture-reviewer, security-reviewer, test-planner の subagent を並列に使って、この変更をレビューしてください。全員の結果を待って統合してください。
```

## Validation

rules:

```bash
codex execpolicy check --pretty --rules .codex/rules/project.rules -- git reset --hard
codex execpolicy check --pretty --rules .codex/rules/project.rules -- git push
codex execpolicy check --pretty --rules .codex/rules/project.rules -- pnpm add zod
codex execpolicy check --pretty --rules .codex/rules/project.rules -- pnpm verify
codex execpolicy check --pretty --rules .codex/rules/project.rules -- rm -rf node_modules
```

hooks:

```bash
PYTHONPYCACHEPREFIX=/tmp/upto-pycache python3 -m py_compile .codex/hooks/codex_hook_guard.py
PYTHONPYCACHEPREFIX=/tmp/upto-pycache python3 -m py_compile .codex/hooks/self_feedback.py
printf '{"prompt":"hello"}' | /usr/bin/python3 .codex/hooks/codex_hook_guard.py --mode user-prompt
printf '{"prompt":"sk-example-secret-secret-secret-secret"}' | /usr/bin/python3 .codex/hooks/codex_hook_guard.py --mode user-prompt
printf '{"tool_input":{"command":"git reset --hard"}}' | /usr/bin/python3 .codex/hooks/codex_hook_guard.py --mode pre-tool
printf '{"tool_input":{"command":"pnpm test"}}' | /usr/bin/python3 .codex/hooks/codex_hook_guard.py --mode pre-tool
/usr/bin/python3 .codex/hooks/self_feedback.py --phase post-tool
/usr/bin/python3 .codex/hooks/self_feedback.py --phase stop
```

config:

```bash
codex --cd . debug prompt-input "harness smoke test" > /tmp/upto-prompt-input.json
codex --strict-config --cd . --ask-for-approval never "Summarize active project instructions." 
```

`debug prompt-input` renders model-visible input without calling a model. The strict config command may call a model. Use it only when an authenticated Codex run is acceptable. For local syntax-only checks, prefer TOML/JSON parsing, `codex execpolicy check`, and direct hook script execution.

As of `codex-cli 0.137.0`, `--strict-config` is not supported by the local-only `debug`, `execpolicy`, or `features` subcommands.

## Maintenance policy

- Update this document when adding or removing Codex control surfaces.
- Keep `AGENTS.md` project identity and validation commands aligned with the latest Accepted ADR; superseded deployment mechanisms must not remain as active agent guidance.
- Collector task deployment is validated from the deploy host with `docker version`, `docker buildx version`, and `pnpm trigger:deploy:dry-run`; the removed Coolify deploy-resource Dockerfile is not an active validation target.
- Do not store user-specific credentials or private absolute paths in repo-scoped files.
- Keep hooks conservative. They should block only clear high-risk cases to avoid surprising normal development.
- Prefer rules for command approval behavior and hooks for cross-cutting prompt/tool checks.
- Use skills for repeatable workflows and subagents for explicit parallel review or exploration.
- `PostToolUse` self-feedback checks mechanical development-flow invariants such as page stories and ADR deletion.
- `Stop` self-feedback runs final checks. For app/package changes it uses `pnpm verify`; for harness changes it also validates hook syntax and command policy.
- Command hooks must not write human-readable logs to stdout. Codex may parse Stop hook stdout as JSON; write progress and child process output to stderr unless the hook intentionally returns a documented JSON payload.
- ADR files are append-only decision records and are never treated as obsolete docs. Do not delete `docs/adr/**`; add a new ADR or append a dated note instead.
- Keep `Stop` self-feedback reasonably fast. Escalate browser E2E, Storybook builds, or Docker checks only when the touched files require them.
