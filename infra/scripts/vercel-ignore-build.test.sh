#!/usr/bin/env sh

set -eu

script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source_script="$script_directory/vercel-ignore-build.sh"
temporary_directory=$(mktemp -d)

cleanup() {
  rm -rf "$temporary_directory"
}

trap cleanup EXIT HUP INT TERM

assert_exit_code() {
  expected_exit_code=$1
  shift

  set +e
  "$@" >/dev/null 2>&1
  actual_exit_code=$?
  set -e

  if [ "$actual_exit_code" -ne "$expected_exit_code" ]; then
    echo "Expected exit code $expected_exit_code, received $actual_exit_code" >&2
    exit 1
  fi
}

mkdir -p "$temporary_directory/infra/scripts" "$temporary_directory/apps/web" "$temporary_directory/packages/domain" "$temporary_directory/docs"
cp "$source_script" "$temporary_directory/infra/scripts/vercel-ignore-build.sh"

git -C "$temporary_directory" init --quiet
git -C "$temporary_directory" config user.email test@example.com
git -C "$temporary_directory" config user.name test

touch "$temporary_directory/apps/web/initial.txt"
git -C "$temporary_directory" add .
git -C "$temporary_directory" commit --quiet -m initial
base_commit=$(git -C "$temporary_directory" rev-parse HEAD)

printf 'changed\n' >"$temporary_directory/apps/web/changed.txt"
git -C "$temporary_directory" add apps/web/changed.txt
git -C "$temporary_directory" commit --quiet -m web-change
web_change_commit=$(git -C "$temporary_directory" rev-parse HEAD)

assert_exit_code 1 env \
  VERCEL_ENV=preview \
  VERCEL_GIT_COMMIT_REF=test \
  VERCEL_GIT_PREVIOUS_SHA="$base_commit" \
  sh "$temporary_directory/infra/scripts/vercel-ignore-build.sh"

printf 'changed\n' >"$temporary_directory/docs/changed.txt"
git -C "$temporary_directory" add docs/changed.txt
git -C "$temporary_directory" commit --quiet -m docs-change
docs_change_commit=$(git -C "$temporary_directory" rev-parse HEAD)

assert_exit_code 0 env \
  VERCEL_ENV=preview \
  VERCEL_GIT_COMMIT_REF=test \
  VERCEL_GIT_PREVIOUS_SHA="$web_change_commit" \
  sh "$temporary_directory/infra/scripts/vercel-ignore-build.sh"

assert_exit_code 0 env \
  VERCEL_ENV=production \
  VERCEL_GIT_COMMIT_REF=release \
  VERCEL_GIT_PREVIOUS_SHA="$web_change_commit" \
  sh "$temporary_directory/infra/scripts/vercel-ignore-build.sh"

printf 'changed\n' >"$temporary_directory/packages/domain/changed.txt"
git -C "$temporary_directory" add packages/domain/changed.txt
git -C "$temporary_directory" commit --quiet -m package-change

assert_exit_code 1 env \
  VERCEL_ENV=preview \
  VERCEL_GIT_COMMIT_REF=test \
  VERCEL_GIT_PREVIOUS_SHA="$docs_change_commit" \
  sh "$temporary_directory/infra/scripts/vercel-ignore-build.sh"

assert_exit_code 0 env \
  VERCEL_ENV=preview \
  VERCEL_GIT_COMMIT_REF=feature/example \
  VERCEL_GIT_PREVIOUS_SHA="$base_commit" \
  sh "$temporary_directory/infra/scripts/vercel-ignore-build.sh"

assert_exit_code 1 env \
  VERCEL_ENV=production \
  VERCEL_GIT_COMMIT_REF=release \
  VERCEL_GIT_PREVIOUS_SHA="$docs_change_commit" \
  sh "$temporary_directory/infra/scripts/vercel-ignore-build.sh"

echo "vercel-ignore-build tests passed"
