---
name: storymesh
description: Audit Storybook story coverage with the Storymesh CLI. Use when an agent needs to find components without stories, report Storybook coverage, generate minimal story skeletons on explicit request, or add a Storymesh check to CI for React, Vue, Svelte, or Angular projects.
---

# Storymesh

Use `storymesh` to compare component files with adjacent Storybook stories. It
supports React, Vue, Svelte, and Angular.

## Inspect first

1. Identify the target directory and framework from the request. If either is
   unclear, inspect the project for component extensions and Storybook
   configuration before running the command. Pass the framework explicitly:
   `react`, `vue`, `svelte`, or `angular`.
2. Start with a non-mutating command from the project root:

   ```sh
   npx --yes storymesh check src/components --framework react
   npx --yes storymesh coverage src/components --framework react
   npx --yes storymesh report src/components --framework react
   ```

   Use `check` to make missing stories fail an automation step. Use `coverage`
   for the percentage and totals, or `report` for both the percentage and the
   missing files.

3. Interpret `check` exit status `1` as a successful scan that found missing
   stories. Treat exit status `2` as an operational error and report its path
   or command context. `coverage` and `report` normally exit `0` even when
   stories are missing.

## Exclude intentional gaps

When files should not count toward coverage, prefer a committed
`.storymeshignore` in the scan root. Its rules use Git ignore syntax, including
comments, glob patterns, directory patterns, and `!` re-inclusion rules:

```gitignore
generated/
**/*.fixture.tsx
!generated/DocumentedButton.tsx
```

For a one-off command, pass `--ignore` once per pattern. To layer a generated
or team-specific rule file on top of `.storymeshignore`, pass `--ignore-file`:

```sh
npx --yes storymesh check src/components --framework react --ignore 'generated/**'
npx --yes storymesh check src/components --framework react --ignore-file .storymesh-ci-ignore
```

Ignore rules exclude both component and story files. Before adding a broad rule,
run `report` and state which paths it removes from coverage; do not use an
ignore rule to hide an unreviewed missing story.

## Generate only on request

`--generate` writes new story files. Run it only when the user explicitly asks
to create skeleton stories, then review the generated files:

```sh
npx --yes storymesh check src/components --framework react --generate
```

Generation does not overwrite existing files. A successful generation command
exits `0`, including when no stories were missing; run `check` again afterward
when the user needs enforcement confirmation.

## Add to a project or CI

When the user asks to make the check repeatable, install the npm package and
add a project script using the target framework and directory:

```sh
npm install --save-dev storymesh
```

```json
{
  "scripts": {
    "check:stories": "storymesh check src/components --framework react"
  }
}
```

Run `npm run check:stories` locally before placing the same command in CI. Do
not treat a missing story as a tool failure; it is the intended failing result
for `check`.

## Report the result

State the framework and scanned path, the coverage result or missing files, and
whether any files were generated. Call out any inferred framework or path so
the user can correct it.
