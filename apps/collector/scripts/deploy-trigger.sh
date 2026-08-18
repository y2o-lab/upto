#!/bin/sh
set -eu

require_variable() {
  variable_name="$1"
  eval "variable_value=\${$variable_name:-}"
  if [ -z "$variable_value" ]; then
    echo "Required deployment variable is missing: $variable_name" >&2
    exit 1
  fi
}

require_variable TRIGGER_API_URL
require_variable TRIGGER_ACCESS_TOKEN
require_variable TRIGGER_PROJECT_REF
require_variable TRIGGER_DEPLOY_ENV
require_variable TRIGGER_REGISTRY_HOST
require_variable TRIGGER_REGISTRY_USERNAME
require_variable TRIGGER_REGISTRY_PASSWORD

case "$TRIGGER_DEPLOY_ENV" in
  staging | prod) ;;
  *)
    echo "TRIGGER_DEPLOY_ENV must be staging or prod." >&2
    exit 1
    ;;
esac

DOCKER_CONFIG="${TMPDIR:-/tmp}/upto-docker-config-$$"
export DOCKER_CONFIG
umask 077
mkdir "$DOCKER_CONFIG"

# Deployment runs directly on the server that hosts Coolify and Trigger.dev.
# Ignore stale remote Docker settings so the Docker CLI uses its local socket.
unset DOCKER_CERT_PATH DOCKER_CONTEXT DOCKER_HOST DOCKER_TLS_VERIFY

cleanup() {
  docker logout "$TRIGGER_REGISTRY_HOST" >/dev/null 2>&1 || true
  find "$DOCKER_CONFIG" -type f -delete >/dev/null 2>&1 || true
  rmdir "$DOCKER_CONFIG" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "Deploying Trigger.dev tasks from source commit: ${SOURCE_COMMIT:-unknown}"
echo "Using the local Docker daemon for the task image build."
if ! docker version >/dev/null; then
  echo "Cannot access the local Docker daemon. Use the deploy host account that can access /var/run/docker.sock." >&2
  exit 1
fi

printf '%s' "$TRIGGER_REGISTRY_PASSWORD" | docker login \
  --username "$TRIGGER_REGISTRY_USERNAME" \
  --password-stdin \
  "$TRIGGER_REGISTRY_HOST" >/dev/null

pnpm trigger:deploy:dry-run

if [ "$TRIGGER_DEPLOY_ENV" = "staging" ]; then
  pnpm trigger:deploy:staging
else
  pnpm trigger:deploy:prod
fi
