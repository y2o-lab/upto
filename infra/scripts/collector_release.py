"""Saved-plan contract and bootstrap release commands; never print raw provider output."""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

class ReleaseError(ValueError):
    """Only fixed, non-secret diagnostics may use this exception."""


PHASES = ["foundation", "worker", "workflows", "ready"]
PAYLOAD_FILES = ["tfplan", "config.tfvars.json", "control.mjs", "provider.lock.hcl", "release-settings.json", "source-variables.tf", "peer-variables.tf"]
CONFIG_FIELDS = {
    "cloudflare_account_id", "cloudflare_zone_id", "vercel_team_id", "vercel_org_id", "bootstrap_probe_action",
    "collector_domain", "dns_record_name", "dns_record_type",
    "verification_dns_records", "workers_dev_subdomain",
    "compatibility_date", "compatibility_flags", "settings",
}
SETTINGS_FIELDS = {
    "bootstrap_phase", "consumer_enabled", "control_mode", "runtime_verified",
    "secrets_verified", "collection_crons", "maintenance_crons", "queue_retention_seconds",
    "max_retries", "retry_delay_seconds", "max_concurrency", "batch_size", "batch_wait_ms",
    "feed_concurrency", "max_items_per_feed", "stage_concurrency", "in_flight_limit", "gemini_project_id",
    "gemini_rpm", "gemini_tpm", "gemini_rpd", "maintenance_page_limit",
    "maintenance_time_limit_ms", "cleanup_delete_limit",
}
RESOURCE_TYPES = {
    "vercel_collector": {"vercel_project"},
    "domains": {"vercel_project_domain"},
    "dns": {"cloudflare_dns_record"},
    "cloudflare_collector": {
        "terraform_data", "cloudflare_d1_database", "cloudflare_queue",
        "cloudflare_workers_script", "cloudflare_workflow",
        "cloudflare_workers_script_subdomain", "cloudflare_queue_consumer",
        "cloudflare_workers_cron_trigger",
    },
}


def require_ref(ref, event, environment="production", operation="apply", payload=None, repository=None):
    if environment == "production":
        if ref != "refs/heads/release-infra" or event != "workflow_dispatch":
            raise ReleaseError("Production requires the release-infra ref and a trusted event")
        return
    pr = (payload or {}).get("pull_request", {})
    action = (payload or {}).get("action")
    if environment != "staging" or event != "pull_request" or pr.get("base", {}).get("ref") != "staging" or not repository or pr.get("head", {}).get("repo", {}).get("full_name") != repository:
        raise ReleaseError("Staging requires a same-repository PR targeting staging")
    merged = action == "closed" and pr.get("merged") is True
    preview = action in {"opened", "synchronize", "reopened", "ready_for_review"} and not pr.get("draft", False) and re.fullmatch(r"refs/pull/[0-9]+/merge", ref)
    if not ((merged and ref == "refs/heads/staging") or (operation == "plan" and preview)):
        raise ReleaseError("Staging Apply requires a merged PR; unmerged PRs may only Plan")


def require_context(environment, operation):
    event = os.environ["GITHUB_EVENT_NAME"]
    payload = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text()) if environment == "staging" else None
    require_ref(os.environ["GITHUB_REF"], event, environment, operation, payload, os.environ.get("GITHUB_REPOSITORY"))
    commit = os.environ.get("COLLECTOR_COMMIT", os.environ["GITHUB_SHA"])
    if environment == "staging" and (payload or {}).get("action") == "closed":
        if commit != payload.get("pull_request", {}).get("merge_commit_sha"):
            raise ReleaseError("Staging release commit differs from the merged PR commit")
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ReleaseError("Release must use a fixed commit SHA")
    return commit


def require_staging_release(settings):
    if not isinstance(settings, dict) or set(settings) != {"bootstrap_phase", "probe_action"} or settings["bootstrap_phase"] not in PHASES or settings["probe_action"] not in {"none", "inject", "verify"}:
        raise ReleaseError("Invalid staging release settings")
    if settings["probe_action"] == "inject" and settings["bootstrap_phase"] != "worker" or settings["probe_action"] == "verify" and settings["bootstrap_phase"] != "ready":
        raise ReleaseError("Staging probe action must match its bootstrap phase")


def require_phase(old, new):
    if new not in PHASES or (old is None and new != "foundation"):
        raise ReleaseError("First Apply must use foundation")
    if old is not None and (old not in PHASES or not 0 <= PHASES.index(new) - PHASES.index(old) <= 1):
        raise ReleaseError("Bootstrap phase cannot regress or skip registration")


def require_bootstrap(settings):
    if not isinstance(settings, dict) or settings.keys() - SETTINGS_FIELDS:
        raise ReleaseError("Unknown collector settings")
    if settings.get("control_mode", "paused") != "paused" or any([
        settings.get("consumer_enabled", False), settings.get("collection_crons", []),
        settings.get("maintenance_crons", []), settings.get("runtime_verified", False),
    ]):
        raise ReleaseError("The current CI bundle is bootstrap-only; runtime activation is unavailable")


def require_config(config, environment, peer_domain):
    if not isinstance(config, dict) or config.keys() - CONFIG_FIELDS:
        raise ReleaseError("Only allowlisted non-secret Terraform settings are accepted")
    required = {"cloudflare_account_id", "cloudflare_zone_id", "collector_domain", "dns_record_name", "workers_dev_subdomain"}
    if not required <= config.keys():
        raise ReleaseError("Missing non-secret collector configuration")
    domain = config["collector_domain"]
    if not isinstance(domain, str) or not re.fullmatch(r"[a-z0-9][a-z0-9.-]*\.[a-z]{2,}", domain):
        raise ReleaseError("Collector domain must be an FQDN")
    for field in ["cloudflare_account_id", "cloudflare_zone_id"]:
        if not isinstance(config[field], str) or not re.fullmatch(r"[a-f0-9]{32}", config[field]):
            raise ReleaseError("Cloudflare account and zone IDs must be hexadecimal identifiers")
    records = config.get("verification_dns_records", {})
    if not isinstance(records, dict) or any(not re.fullmatch(r"[A-Za-z0-9_.:-]+", name) for name in records):
        raise ReleaseError("Verification record keys must be non-secret DNS identifiers")
    if not isinstance(peer_domain, str) or not re.fullmatch(r"[a-z0-9][a-z0-9.-]*\.[a-z]{2,}", peer_domain) or domain == peer_domain or domain in {"upto.yuno-i.com", "www.upto.yuno-i.com"}:
        raise ReleaseError("Collector and peer/Web hostnames must be distinct")
    if environment not in {"staging", "production"}:
        raise ReleaseError("Unsupported collector environment")
    require_bootstrap(config.get("settings", {}))
    if config.get("settings", {}).get("bootstrap_phase", "foundation") not in PHASES:
        raise ReleaseError("Unsupported bootstrap phase")


def summarize_plan(plan):
    summary = []
    for resource in plan.get("resource_changes", []):
        if resource.get("mode") != "managed":
            continue
        address = resource["address"]
        match = re.fullmatch(r"module\.([a-z_]+)\.[a-z0-9_]+\.[a-z0-9_]+(?:\[[^\n]+\])?", address)
        if not match or resource["type"] not in RESOURCE_TYPES.get(match[1], set()):
            raise ReleaseError("Plan includes a resource outside collector ownership")
        actions = resource["change"]["actions"]
        # Consumer deletion is the explicit reversible switch to stop deliveries.
        if "delete" in actions and not (resource["type"] == "cloudflare_queue_consumer" and actions == ["delete"]):
            raise ReleaseError("Plan would delete or replace a collector resource")
        if actions != ["no-op"]:
            summary.append(f"{address}: {','.join(actions)}")
    return summary


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def make_manifest(folder, commit, environment, run_id, attempt, phase):
    return {
        "format": 1, "commit": commit, "environment": environment,
        "run_id": run_id, "run_attempt": attempt, "bootstrap_phase": phase,
        "root": f"infra/environments/collector-{environment}",
        "state_key": f"collector-{environment}/terraform.tfstate",
        "terraform_version": "1.11.4", "bundle_kind": "bootstrap",
        "files": {name: sha256(folder / name) for name in PAYLOAD_FILES},
    }


def verify_manifest(folder, manifest, commit, environment, run_id, attempt):
    expected = make_manifest(folder, commit, environment, run_id, attempt, manifest.get("bootstrap_phase"))
    if manifest != expected or manifest["bootstrap_phase"] not in PHASES:
        raise ReleaseError("Release commit/environment/run/file hashes do not match")


def terraform(root, *arguments, output_file=None):
    # All raw stdout/stderr remains in the private staging area. Failures expose no values.
    result = subprocess.run([os.environ.get("TERRAFORM_BIN", "terraform"), f"-chdir={root}", *arguments], capture_output=True)
    with (Path(".collector-release") / "terraform.log").open("ab") as log:
        log.write(result.stdout)
        log.write(result.stderr)
    if result.returncode:
        raise ReleaseError(f"Terraform {arguments[0]} failed (exit {result.returncode}); check service permissions and bootstrap prerequisites")
    if output_file:
        Path(output_file).write_bytes(result.stdout)
    return result.stdout


def configuration_path(environment):
    return Path(f"infra/environments/collector-{environment}/variables.tf")


def read_defaults(path):
    # Evaluate only variable declarations in a backend/provider-free directory.
    # No TF_VAR_*, tfvars files, state, or CI credentials can override defaults.
    expression = "jsonencode({" + ",".join(f"{name}=var.{name}" for name in sorted(CONFIG_FIELDS)) + "})\n"
    env = {name: os.environ[name] for name in ["PATH", "HOME", "TMPDIR", "SYSTEMROOT"] if name in os.environ}
    env.update({"TF_IN_AUTOMATION": "true", "TF_INPUT": "false"})
    with tempfile.TemporaryDirectory(prefix="upto-collector-defaults-") as directory:
        shutil.copyfile(path, Path(directory) / "variables.tf")
        result = subprocess.run([os.environ.get("TERRAFORM_BIN", "terraform"), f"-chdir={directory}", "console", "-no-color"], input=expression.encode(), capture_output=True, env=env, timeout=30)
    if result.returncode:
        raise ReleaseError("Cannot evaluate checked-in Terraform variable defaults")
    # console prints a Terraform string containing the serialized object.
    lines = result.stdout.decode().strip().splitlines()
    if not lines:
        raise ReleaseError("Terraform did not return variable defaults")
    # console can print validation diagnostics before the final result when a
    # peer environment still has intentionally unset IDs. Validate target values
    # separately and let Plan enforce the original HCL validations.
    return json.loads(json.loads(lines[-1]))


def load_configuration(environment):
    config = read_defaults(configuration_path(environment))
    peer_environment = "production" if environment == "staging" else "staging"
    peer = read_defaults(configuration_path(peer_environment))
    if not isinstance(peer, dict) or peer.keys() - CONFIG_FIELDS:
        raise ReleaseError("Peer configuration must contain only non-secret Terraform settings")
    require_config(config, environment, peer.get("collector_domain", ""))
    settings = {"bootstrap_phase": config.get("settings", {}).get("bootstrap_phase", "foundation"), "probe_action": config.get("bootstrap_probe_action", "none")}
    require_staging_release(settings)
    if environment == "production" and settings["probe_action"] != "none":
        raise ReleaseError("Bootstrap secret probe is staging-only")
    return config, settings, peer_environment


def plan(args):
    commit = require_context(args.environment, "plan")
    config, release_settings, peer_environment = load_configuration(args.environment)
    folder = Path(".collector-release")
    folder.mkdir(mode=0o700, exist_ok=True)
    shutil.copyfile(configuration_path(args.environment), folder / "source-variables.tf")
    shutil.copyfile(configuration_path(peer_environment), folder / "peer-variables.tf")
    (folder / "release-settings.json").write_text(json.dumps(release_settings))
    shutil.copyfile("infra/bootstrap/control.mjs", folder / "control.mjs")
    config["bundle_path"] = "../../../.collector-release/control.mjs"
    config["bundle_sha256"] = sha256(folder / "control.mjs")
    config_file = folder / "config.tfvars.json"
    config_file.write_text(json.dumps(config))
    root = Path(f"infra/environments/collector-{args.environment}")
    shutil.copyfile(root / ".terraform.lock.hcl", folder / "provider.lock.hcl")
    terraform(root, "init", "-lockfile=readonly", "-no-color")
    outputs = json.loads(terraform(root, "output", "-json"))
    require_phase(outputs.get("bootstrap_phase", {}).get("value"), config.get("settings", {}).get("bootstrap_phase", "foundation"))
    terraform(root, "plan", "-no-color", "-lock-timeout=5m", f"-var-file={config_file.resolve()}", f"-out={(folder / 'tfplan').resolve()}")
    planned = json.loads(terraform(root, "show", "-json", str((folder / "tfplan").resolve())))
    summary = summarize_plan(planned)
    manifest = make_manifest(folder, commit, args.environment, os.environ["GITHUB_RUN_ID"], os.environ["GITHUB_RUN_ATTEMPT"], config.get("settings", {}).get("bootstrap_phase", "foundation"))
    (folder / "manifest.json").write_text(json.dumps(manifest, indent=2))
    certificate = folder / "encryption.crt"
    certificate.write_text(os.environ["TF_PLAN_ENCRYPTION_CERT"])
    with tarfile.open(folder / "release.tar", "w") as archive:
        for name in [*PAYLOAD_FILES, "manifest.json"]:
            archive.add(folder / name, arcname=name)
    result = subprocess.run(["openssl", "cms", "-encrypt", "-aes256", "-binary", "-outform", "DER", "-in", str(folder / "release.tar"), "-out", str(folder / "release.enc"), str(certificate)], capture_output=True)
    if result.returncode:
        raise ReleaseError("Plan encryption failed; no artifact may be uploaded")
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        output.write(f"ciphertext_sha256={sha256(folder / 'release.enc')}\n")
    with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as report:
        report.write(f"Collector {args.environment}, commit `{manifest['commit']}`, phase `{manifest['bootstrap_phase']}`\n\n")
        report.write("\n".join(f"- `{line}`" for line in summary) or "No resource changes.")
        report.write("\n\nEncrypted plan expires after one day. Raw plan/state/JSON is not published.\n")


def apply(args):
    commit = require_context(args.environment, "apply")
    folder = Path(".collector-release")
    if sha256(folder / "release.enc") != os.environ["EXPECTED_CIPHERTEXT_SHA256"]:
        raise ReleaseError("Encrypted artifact hash mismatch")
    key = folder / "decryption.key"
    key.write_text(os.environ["TF_PLAN_DECRYPTION_KEY"])
    key.chmod(0o600)
    result = subprocess.run(["openssl", "cms", "-decrypt", "-binary", "-inform", "DER", "-in", str(folder / "release.enc"), "-inkey", str(key), "-out", str(folder / "release.tar")], capture_output=True)
    if result.returncode:
        raise ReleaseError("Plan decryption failed")
    with tarfile.open(folder / "release.tar") as archive:
        if {entry.name for entry in archive} != {*PAYLOAD_FILES, "manifest.json"} or not all(entry.isfile() for entry in archive):
            raise ReleaseError("Unexpected encrypted package entries")
        for entry in archive:
            (folder / entry.name).write_bytes(archive.extractfile(entry).read())
    manifest = json.loads((folder / "manifest.json").read_text())
    verify_manifest(folder, manifest, commit, args.environment, os.environ["GITHUB_RUN_ID"], os.environ["GITHUB_RUN_ATTEMPT"])
    release_settings = json.loads((folder / "release-settings.json").read_text())
    _, expected_settings, peer_environment = load_configuration(args.environment)
    if release_settings != expected_settings or sha256(configuration_path(args.environment)) != manifest["files"]["source-variables.tf"] or sha256(configuration_path(peer_environment)) != manifest["files"]["peer-variables.tf"]:
        raise ReleaseError("Terraform configuration differs from the reviewed commit")
    root = Path(manifest["root"])
    if sha256(root / ".terraform.lock.hcl") != manifest["files"]["provider.lock.hcl"] or sha256("infra/bootstrap/control.mjs") != manifest["files"]["control.mjs"]:
        raise ReleaseError("Checked out lockfile or bootstrap source differs from the saved release")
    terraform(root, "init", "-lockfile=readonly", "-no-color")
    # No replan, no -auto-approve; Terraform itself rejects stale saved plans.
    terraform(root, "apply", "-no-color", "-lock-timeout=5m", str((folder / "tfplan").resolve()))
    outputs = json.loads(terraform(root, "output", "-json"))
    # Identifiers are transferred privately for follow-up deploy/secret/migration steps.
    (folder / "outputs.json").write_text(json.dumps(outputs))
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as step_output:
        step_output.write(f"probe_action={release_settings['probe_action']}\n")
        for name in ["collector_project_id", "collector_origin", "gate_origin", "bootstrap_phase"]:
            item = outputs.get(name, {})
            value = item.get("value")
            if value is not None:
                if item.get("sensitive") or not isinstance(value, str) or "\n" in value or "\r" in value:
                    raise ReleaseError("Unexpected sensitive or multiline release output")
                step_output.write(f"{name}={value}\n")
    with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as report:
        report.write(f"Applied saved collector {args.environment} plan for `{manifest['commit']}`. Consumer and Cron remain disabled.\n")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["plan", "apply"])
    parser.add_argument("environment", choices=["staging", "production"])
    args = parser.parse_args()
    os.umask(0o077)
    try:
        globals()[args.operation](args)
    except ReleaseError as failure:
        raise SystemExit("Collector release stopped: " + str(failure))
    except (ValueError, KeyError, OSError, json.JSONDecodeError, subprocess.TimeoutExpired):
        # Provider errors/secret input/JSON content must never reach public logs.
        raise SystemExit("Collector release stopped: configuration, phase, artifact, or Terraform validation failed.")
