#!/bin/sh
set -eu
TF=${TERRAFORM_BIN:-terraform}
"$TF" -chdir=infra fmt -check -recursive
"$TF" -chdir=infra/environments/production init -backend=false -lockfile=readonly
"$TF" -chdir=infra/environments/production validate
for directory in infra/modules/vercel-collector infra/modules/cloudflare-collector infra/environments/collector-staging infra/environments/collector-production; do
  "$TF" -chdir="$directory" init -backend=false -lockfile=readonly
  "$TF" -chdir="$directory" validate
  "$TF" -chdir="$directory" test
done
python3 -m unittest discover -s infra/scripts -p '*_test.py'
node --experimental-vm-modules --test infra/bootstrap/control.test.mjs
# `providers schema` requires backend initialization even with -backend=false.
# Use a temporary local-backend root with the same fixed versions and lockfile.
schema_directory="$(mktemp -d "${TMPDIR:-/tmp}/upto-collector-schema.XXXXXX")"
trap 'rm -rf -- "$schema_directory"' EXIT HUP INT TERM
cp infra/environments/collector-staging/versions.tf "$schema_directory/versions.tf"
cp infra/environments/collector-staging/.terraform.lock.hcl "$schema_directory/.terraform.lock.hcl"
"$TF" -chdir="$schema_directory" init -backend=false -lockfile=readonly -plugin-dir="$(pwd)/infra/environments/collector-staging/.terraform/providers"
"$TF" -chdir="$schema_directory" providers schema -json | python3 infra/scripts/check-collector-schema.py
