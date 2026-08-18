# Codex project guidance

## Project identity

This repository is for a Japanese IT news summary application.

The accepted MVP direction is documented in [docs/adr/0001-technology-stack.md](docs/adr/0001-technology-stack.md):

- TypeScript monorepo
- pnpm workspace
- Next.js App Router
- React 19, Tailwind CSS v4, shadcn/ui
- PostgreSQL
- Drizzle ORM and Drizzle Kit
- Ubuntu Server, Coolify, and self-hosted Trigger.dev for collector deployment and execution
- Gemini API through `@google/genai`
- oxlint and oxfmt for fast linting and formatting
- Vitest and Playwright for verification

Treat the ADR as the source of truth when implementation details are ambiguous. If the direction changes, create a new ADR instead of silently rewriting accepted decisions.

## Working rules

- Read the relevant docs under `docs/` before changing architecture, database design, batch behavior, or UI flow.
- Keep changes scoped to the requested task. Avoid unrelated refactors and broad formatting churn.
- Preserve existing user changes. Do not revert or overwrite work unless the user explicitly asks.
- Prefer Japanese for project documentation and user-facing product copy. Code identifiers, comments, and commit-style technical artifacts may use English when clearer.
- Never commit secrets, API keys, database URLs, cookies, tokens, private keys, or local `.env` files.
- Use `.env.example` or `.env.local.example` for required environment variable names only.
- Follow TDD for collector, app logic, shared domain logic, database code, and validation/scoring changes. Add or update the narrowest meaningful Vitest coverage before or with the implementation.
- After implementation, remove obsolete handoff notes, temporary verification notes, and other stale docs when the code or harness is now the source of truth. ADRs are never "unnecessary docs"; keep ADRs append-only and preserve enduring operational runbooks.

## Architecture constraints

- Put web code under `apps/web`.
- Put collector and scheduled batch code under `apps/collector`.
- Put Trigger.dev task entrypoints under `apps/collector/src/trigger` and keep them as thin adapters over testable collector logic.
- Put Drizzle schema, migrations, and DB client code under `packages/db`.
- Put shared domain logic, normalization, scoring, and validation schemas under `packages/domain`.
- Keep collector work idempotent. A single article failure must not fail the whole crawl when the rest of the batch can continue.
- Store job status, retry counts, and error summaries in the database design when implementing batch persistence.
- Prefer explicit Zod schemas for external inputs and LLM JSON outputs.
- Keep Gemini model names, API keys, database URLs, and deployment-specific settings in environment variables.
- Manage batch schedules, logs, execution history, and reruns in Trigger.dev. Do not add systemd timers for collector execution.
- Keep Trigger.dev task runtime secrets in Trigger.dev and deployment credentials in the deploy host's secret management; never bake either into Docker images or build arguments.

## Frontend constraints

- Read [DESIGN.md](DESIGN.md) before creating or substantially changing UI.
- Build the usable news feed first; do not turn the first screen into a marketing page.
- The feed must support mobile vertical swipe and desktop wheel/trackpad-as-swipe behavior.
- Use CSS scroll snap as the baseline interaction and add client-side input control only where needed.
- Support keyboard navigation: Up for previous, Down for next, Space for next, Shift+Space for previous.
- Keep article cards readable and dense. Avoid decorative layouts that reduce scan speed.
- When adding a new `apps/web/src/app/**/page.tsx`, add the sibling `page.stories.tsx`. Stories for small internal components are optional until the user asks for them.
- Verify responsive behavior with Playwright once a runnable frontend exists.

## Documentation and ADR rules

- ADR files are append-only. Follow [docs/adr/README.md](docs/adr/README.md).
- Do not delete or rewrite the meaning of an accepted ADR.
- If a decision changes, add a new ADR and append a supersession note to the old ADR.
- Put enduring operational knowledge in checked-in docs, not only in Codex memory or chat context.

## Validation expectations

Run the narrowest meaningful checks for the files changed.

When the monorepo exists, prefer:

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm exec playwright test
```

Use `pnpm format` to apply oxfmt. Do not add ESLint or Prettier unless the user explicitly reverses the oxlint/oxfmt decision.

When changing only Markdown or Codex harness files, validate the relevant harness syntax instead of pretending application tests exist.

For Trigger.dev or collector deployment changes, also run the narrowest applicable checks:

```bash
pnpm --filter @upto/collector test
pnpm --filter @upto/collector typecheck
pnpm trigger:deploy:dry-run
sh -n apps/collector/scripts/deploy-trigger.sh
docker version
docker buildx version
```

`pnpm trigger:deploy:dry-run` requires non-secret Trigger.dev connection settings. Docker deployment checks must not mount the host Docker socket.

For Codex harness changes, run:

```bash
codex execpolicy check --pretty --rules .codex/rules/project.rules -- git reset --hard
/usr/bin/python3 .codex/hooks/codex_hook_guard.py --mode user-prompt < /dev/null
```

## Review guidelines

- Prioritize correctness, data loss, security, privacy, missing tests, operational failure modes, and user-visible regressions.
- Treat accidental secret exposure as P1.
- Treat destructive commands, unsafe migrations, non-idempotent collector behavior, and unbounded LLM/API concurrency as high risk.
- For UI changes, check mobile and desktop behavior, text overflow, keyboard interaction, and loading/error/empty states.
- When a repeated agent mistake, review finding, or policy violation looks useful to promote into the harness, record it in a GitHub Issue using the harness feedback template. If a pattern reaches three occurrences, propose a concrete harness change before implementing it.

## Codex harness map

- Repository instructions: `AGENTS.md`.
- Project Codex config: `.codex/config.toml`.
- Command approval policy rules: `.codex/rules/project.rules`.
- Lifecycle hooks: `.codex/hooks.json` and `.codex/hooks/`.
- Repo skills: `.agents/skills/`.
- Custom subagents: `.codex/agents/`.

Project-local `.codex/` layers load only when the repository is trusted by Codex. After changing hooks, open `/hooks` in Codex CLI and review/trust the updated hook definitions.
