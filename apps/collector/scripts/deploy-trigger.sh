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
require_variable DOCKER_HOST
require_variable DOCKER_CERT_PATH

case "$DOCKER_HOST" in
  unix://* | */var/run/docker.sock)
    echo "A host Docker socket is not allowed. Use a dedicated TLS-protected build executor." >&2
    exit 1
    ;;
  tcp://*) ;;
  *)
    echo "DOCKER_HOST must use a remote tcp:// build executor." >&2
    exit 1
    ;;
esac

if [ "${DOCKER_TLS_VERIFY:-}" != "1" ]; then
  echo "DOCKER_TLS_VERIFY=1 is required." >&2
  exit 1
fi

if [ ! -r "$DOCKER_CERT_PATH/ca.pem" ] || [ ! -r "$DOCKER_CERT_PATH/cert.pem" ] || [ ! -r "$DOCKER_CERT_PATH/key.pem" ]; then
  echo "Docker TLS client certificates are missing from DOCKER_CERT_PATH." >&2
  exit 1
fi

case "$TRIGGER_DEPLOY_ENV" in
  staging | prod) ;;
  *)
    echo "TRIGGER_DEPLOY_ENV must be staging or prod." >&2
    exit 1
    ;;
esac

echo "Deploying Trigger.dev tasks from source commit: ${SOURCE_COMMIT:-unknown}"
docker version >/dev/null
DOCKER_CONFIG="${TMPDIR:-/tmp}/upto-docker-config-$$"
export DOCKER_CONFIG
umask 077
mkdir "$DOCKER_CONFIG"

cleanup() {
  docker logout "$TRIGGER_REGISTRY_HOST" >/dev/null 2>&1 || true
  find "$DOCKER_CONFIG" -type f -delete >/dev/null 2>&1 || true
  rmdir "$DOCKER_CONFIG" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

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
