#!/bin/sh
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../../../.." && pwd)
cd "$repo_dir"

docker build --platform linux/amd64 -f apps/web/e2e/visual/Dockerfile -t upto-web-vrt .
mkdir -p apps/web/e2e/visual/snapshots test-results/visual playwright-report/visual
docker run --rm --init --platform linux/amd64 --shm-size=1g \
  -e CI="${CI:-}" \
  --mount "type=bind,source=$repo_dir/apps/web/e2e/visual/snapshots,target=/app/apps/web/e2e/visual/snapshots" \
  --mount "type=bind,source=$repo_dir/test-results/visual,target=/app/test-results/visual" \
  --mount "type=bind,source=$repo_dir/playwright-report/visual,target=/app/playwright-report/visual" \
  upto-web-vrt "$@"
