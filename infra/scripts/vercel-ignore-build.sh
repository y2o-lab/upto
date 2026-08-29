#!/usr/bin/env sh

# Vercel continues a build only when this script exits with 1. It executes from
# apps/web, so resolve the repository root from this checked-in script instead.
set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repository_root=$(CDPATH= cd -- "$script_directory/../.." && pwd)
preview_branch=${UPTO_VERCEL_PREVIEW_BRANCH:-test}

cd "$repository_root"

if [ "${VERCEL_ENV:-}" = "preview" ] && [ "${VERCEL_GIT_COMMIT_REF:-}" != "$preview_branch" ]; then
  echo "Skipping preview: only $preview_branch creates preview deployments."
  exit 0
fi

comparison_commit=${VERCEL_GIT_PREVIOUS_SHA:-HEAD^}

if ! git rev-parse --verify "$comparison_commit^{commit}" >/dev/null 2>&1; then
  echo "Building: no previous deployment commit is available for comparison."
  exit 1
fi

if git diff --quiet "$comparison_commit" HEAD -- \
  apps/web \
  packages \
  package.json \
  pnpm-lock.yaml \
  pnpm-workspace.yaml; then
  echo "Skipping: no apps/web, packages, or workspace dependency changes."
  exit 0
fi

echo "Building: relevant web or workspace package changes were detected."
exit 1
