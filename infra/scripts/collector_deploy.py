"""Upload only tracked merge-commit source; never upload decrypted Terraform material."""
import http.client
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlencode

from collector_release import ReleaseError, require_context


def run_private(command, **kwargs):
    result = subprocess.run(command, capture_output=True, timeout=1800, **kwargs)
    if result.returncode:
        raise ReleaseError("Vercel deployment command failed; inspect service-side build diagnostics")
    return result.stdout


def deployment_command(environment, commit, project_id, org_id, token):
    if not re.fullmatch(r"prj_[A-Za-z0-9]+", project_id) or not re.fullmatch(r"(?:team_|user_)?[A-Za-z0-9]+", org_id) or not token:
        raise ReleaseError("Missing or invalid Vercel project, owner, or deployment credential")
    # Do not pass Terraform/R2/Cloudflare credentials to the CLI process.
    env = {name: os.environ[name] for name in ["PATH", "HOME", "TMPDIR", "SYSTEMROOT"] if name in os.environ}
    env.update({"CI": "true", "VERCEL_TELEMETRY_DISABLED": "1", "VERCEL_PROJECT_ID": project_id, "VERCEL_ORG_ID": org_id})
    return [
        "pnpm", "dlx", "vercel@59.15.0", "deploy", "--prod", "--yes", "--token", token,
        "--env", "COLLECTOR_NODE_ENABLED=false",
        "--env", f"COLLECTOR_ENVIRONMENT={environment}",
        "--meta", f"collectorCommit={commit}",
        "--meta", f"collectorEnvironment={environment}",
    ], env


def collector_environment(environment):
    """Validate all inputs before writing any Vercel project setting."""
    entries = []
    for name in ["GEMINI_MODEL_PRIMARY", "GEMINI_MODEL_FALLBACK", "GEMINI_API_KEY"]:
        value = environment.get(name, "")
        if not value.strip():
            raise ReleaseError(f"Missing GitHub Environment setting: {name}")
        if name != "GEMINI_API_KEY" and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9./:_-]{0,127}", value):
            raise ReleaseError(f"Invalid Gemini model setting: {name}")
        entries.append({"key": name, "value": value, "type": "sensitive" if name == "GEMINI_API_KEY" else "plain", "target": ["production"]})
    chunk = environment.get("COLLECTOR_CHUNK_CHARS", "12000")
    if not re.fullmatch(r"[0-9]+", chunk) or not 1000 <= int(chunk) <= 100000:
        raise ReleaseError("Invalid collector chunk setting: COLLECTOR_CHUNK_CHARS")
    entries.append({"key": "COLLECTOR_CHUNK_CHARS", "value": chunk, "type": "plain", "target": ["production"]})
    return entries


def sync_collector_environment(project_id, org_id, token, entries):
    """Upsert through HTTPS without redirects, response logging, or disk storage."""
    query = {"upsert": "true"}
    if org_id.startswith("team_"):
        query["teamId"] = org_id
    path = f"/v10/projects/{project_id}/env?{urlencode(query)}"
    connection = http.client.HTTPSConnection("api.vercel.com", timeout=30)
    try:
        for entry in entries:
            connection.request("POST", path, body=json.dumps(entry).encode(), headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
            response = connection.getresponse()
            body = response.read()
            if response.status != 200 and response.status != 201:
                raise ReleaseError("Vercel collector environment registration failed; deployment stopped")
            result = json.loads(body)
            created = result.get("created", {})
            if result.get("failed") or not isinstance(created, dict) or any(created.get(name) != entry[name] for name in ["key", "type", "target"]):
                raise ReleaseError("Vercel did not confirm collector environment registration; deployment stopped")
    except (OSError, http.client.HTTPException, ValueError, AttributeError):
        raise ReleaseError("Vercel collector environment registration failed; deployment stopped") from None
    finally:
        connection.close()


def deploy(environment, folder=Path(".collector-release")):
    commit = require_context(environment, "apply")
    manifest = json.loads((folder / "manifest.json").read_text())
    if manifest["commit"] != commit or manifest["environment"] != environment:
        raise ReleaseError("Vercel source differs from the applied release")
    config = json.loads((folder / "config.tfvars.json").read_text())
    outputs = json.loads((folder / "outputs.json").read_text())
    project = outputs["collector_project_id"]
    if project.get("sensitive"):
        raise ReleaseError("Unexpected sensitive project output")
    # Team scope comes from the applied Plan; personal accounts need their owner ID.
    org = config.get("vercel_team_id") or config.get("vercel_org_id", "")
    token = os.environ.get("VERCEL_API_TOKEN", "")
    command, env = deployment_command(environment, commit, project["value"], org, token)
    entries = collector_environment(os.environ)
    # Both isolated staging and production projects deploy with --prod, so both
    # use Vercel's production target (never the other project's environment).
    sync_collector_environment(project["value"], org, token, entries)
    with tempfile.TemporaryDirectory(prefix="upto-collector-deploy-") as temporary:
        archive = Path(temporary) / "source.tar"
        source = Path(temporary) / "source"
        source.mkdir()
        run_private(["git", "archive", "--format=tar", f"--output={archive}", commit])
        run_private(["tar", "-xf", str(archive), "-C", str(source)])
        # Root Directory is apps/collector on the Terraform project. Upload the
        # monorepo root so workspace packages/lockfile remain available remotely.
        lines = run_private(command, cwd=source, env=env).decode().strip().splitlines()
        deployed = lines[-1].strip() if lines else ""
    if not re.fullmatch(r"https://[a-zA-Z0-9-]+\.vercel\.app", deployed):
        raise ReleaseError("Vercel returned an unexpected deployment URL; verify in dashboard before retrying")
    with Path(os.environ["GITHUB_STEP_SUMMARY"]).open("a") as report:
        report.write(f"Collector {environment} Functions deployed from `{commit}`: {deployed}. Node execution remains disabled.\n")
    with Path(os.environ["GITHUB_OUTPUT"]).open("a") as output:
        output.write(f"deployment_url={deployed}\n")


if __name__ == "__main__":
    os.umask(0o077)
    try:
        if len(sys.argv) != 2 or sys.argv[1] not in ["staging", "production"]:
            raise ReleaseError("Expected staging or production")
        deploy(sys.argv[1])
    except ReleaseError as failure:
        raise SystemExit("Collector deployment stopped: " + str(failure))
    except (ValueError, KeyError, OSError, subprocess.TimeoutExpired):
        raise SystemExit("Collector deployment stopped: configuration or CLI execution failed")
