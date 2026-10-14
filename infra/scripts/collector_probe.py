"""Optional staging-only secret-retention PoC after an approved saved-plan Apply."""
import argparse
import hashlib
import hmac
import json
import os
import re
import secrets
import subprocess
import urllib.request
from pathlib import Path

from collector_release import require_context


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, url):
        return None


def request_json(url, headers=None, payload=None, method="GET"):
    request = urllib.request.Request(url, headers=headers or {}, data=None if payload is None else json.dumps(payload).encode(), method=method)
    with urllib.request.build_opener(NoRedirect).open(request, timeout=15) as response:
        raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024:
            raise ValueError("Oversized probe response")
        return json.loads(raw)


def check_secret_absent(value, secret):
    if secret in json.dumps(value, ensure_ascii=False):
        raise ValueError("Probe secret appeared in provider read-back, saved Plan, or state")


def run(action):
    require_context("staging", "apply")
    folder = Path(".collector-release")
    manifest = json.loads((folder / "manifest.json").read_text())
    if manifest["environment"] != "staging" or manifest["bootstrap_phase"] == "foundation":
        raise ValueError("Probe requires an applied staging Worker")
    secret = os.environ["COLLECTOR_BOOTSTRAP_PROBE_KEY"]
    if not re.fullmatch(r"[A-Za-z0-9_-]{43,128}", secret):
        raise ValueError("Use a dedicated random base64url PoC key, never a collector signing key")
    config = json.loads((folder / "config.tfvars.json").read_text())
    outputs = json.loads((folder / "outputs.json").read_text())
    script = "upto-collector-staging-control"
    account = config["cloudflare_account_id"]
    if not re.fullmatch(r"[a-f0-9]{32}", account):
        raise ValueError("Invalid account")
    base = f"https://api.cloudflare.com/client/v4/accounts/{account}/workers/scripts/{script}"
    headers = {"Authorization": "Bearer " + os.environ["CLOUDFLARE_API_TOKEN"], "Content-Type": "application/json"}
    if action == "inject":
        response = request_json(base + "/secrets", headers, {"name": "COLLECTOR_BOOTSTRAP_PROBE_KEY", "text": secret, "type": "secret_text"}, "PUT")
        if not response.get("success"):
            raise ValueError("Secret injection failed")
    root = f"infra/environments/collector-staging"
    planned = subprocess.run([os.environ.get("TERRAFORM_BIN", "terraform"), f"-chdir={root}", "show", "-json", str((folder / "tfplan").resolve())], check=True, capture_output=True)
    plan = json.loads(planned.stdout)
    if action == "verify" and not any(resource.get("type") == "cloudflare_workers_script" and resource.get("change", {}).get("actions") == ["update"] for resource in plan.get("resource_changes", [])):
        raise ValueError("Retention verification must follow a Plan that updates the Worker")
    settings = request_json(base + "/settings", headers)
    if not settings.get("success") or not any(binding.get("name") == "COLLECTOR_BOOTSTRAP_PROBE_KEY" and binding.get("type") == "secret_text" for binding in settings.get("result", {}).get("bindings", [])):
        raise ValueError("Secret binding missing after Apply")
    state = subprocess.run([os.environ.get("TERRAFORM_BIN", "terraform"), f"-chdir={root}", "state", "pull"], check=True, capture_output=True)
    for value in [settings, plan, json.loads(state.stdout)]:
        check_secret_absent(value, secret)
    origin = outputs["gate_origin"]["value"]
    expected = f"https://{script}.{config['workers_dev_subdomain']}.workers.dev"
    if origin != expected:
        raise ValueError("Gate origin differs from the saved Terraform contract")
    nonce = secrets.token_hex(32)
    signature = hmac.new(secret.encode(), f"request\n{nonce}".encode(), hashlib.sha256).hexdigest()
    result = request_json(origin + "/__bootstrap/secret-retention?nonce=" + nonce, {"x-bootstrap-signature": signature})
    proof = hmac.new(secret.encode(), f"response\n{nonce}".encode(), hashlib.sha256).hexdigest()
    if not isinstance(result.get("proof"), str) or not hmac.compare_digest(result["proof"], proof):
        raise ValueError("Gate key retention proof failed")
    with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as report:
        report.write(f"\nStaging bootstrap secret PoC: {action} succeeded; HTTPS proof matched and no value appeared in read-back, saved Plan, or state.\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["inject", "verify"])
    args = parser.parse_args()
    try:
        run(args.action)
    except Exception:
        raise SystemExit("Staging bootstrap secret PoC failed; keep consumer and Cron disabled.")
