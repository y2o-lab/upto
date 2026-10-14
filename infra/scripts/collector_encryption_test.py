"""Exercise actual CMS encryption and the saved-plan handoff with a fake local CLI."""
import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("collector_release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class EncryptedHandoffTests(unittest.TestCase):
    def test_encrypted_plan_handoff_never_replans_on_apply(self):
        with tempfile.TemporaryDirectory() as directory:
            previous = Path.cwd()
            workspace = Path(directory)
            try:
                os.chdir(workspace)
                root = workspace / "infra/environments/collector-staging"
                root.mkdir(parents=True)
                (root / ".terraform.lock.hcl").write_text("fixture lock")
                event_file = workspace / "event.json"
                event_file.write_text(json.dumps({"action": "closed", "pull_request": {"base": {"ref": "staging"}, "head": {"repo": {"full_name": "fixture/upto"}}, "merged": True, "merge_commit_sha": "a" * 40}}))
                bootstrap = workspace / "infra/bootstrap"
                bootstrap.mkdir(parents=True)
                (bootstrap / "control.mjs").write_text("// stopped bundle")
                cli = workspace / "terraform-fixture"
                cli.write_text('''#!/usr/bin/env python3
import json,sys,pathlib,os
args=sys.argv[2:]
with pathlib.Path("calls.jsonl").open("a") as file: file.write(json.dumps(args)+"\\n")
if args[0] == "output": print('{"collector_project_id":{"value":"prj_fixture","sensitive":false},"collector_origin":{"value":"https://collector-staging.example.com","sensitive":false},"bootstrap_phase":{"value":"foundation","sensitive":false}}')
if args[0] == "apply" and os.environ.get("FIXTURE_STALE_PLAN"):
    sys.stderr.write("private stale-plan diagnostics")
    sys.exit(1)
if args[0] == "plan":
    output=next(arg[5:] for arg in args if arg.startswith("-out="))
    pathlib.Path(output).write_bytes(b"saved plan fixture with private value")
if args[0] == "show": print('{"resource_changes": []}')
''')
                cli.chmod(0o700)
                key = workspace / "rsa.key"
                cert = workspace / "rsa.crt"
                subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", str(key), "-out", str(cert), "-days", "1", "-subj", "/CN=collector-plan-test"], check=True, capture_output=True)
                config = {"cloudflare_account_id": "0" * 32, "cloudflare_zone_id": "1" * 32, "collector_domain": "collector-staging.example.com", "dns_record_name": "collector-staging", "workers_dev_subdomain": "fixture"}
                (root / "variables.tf").write_text(json.dumps(config))
                peer = workspace / "infra/environments/collector-production"
                peer.mkdir()
                (peer / "variables.tf").write_text(json.dumps({**config, "collector_domain": "collector-production.example.com"}))
                env = {
                    "GITHUB_REF": "refs/heads/staging", "GITHUB_EVENT_NAME": "pull_request",
                    "GITHUB_EVENT_PATH": str(event_file), "GITHUB_REPOSITORY": "fixture/upto",
                    "GITHUB_SHA": "a" * 40, "COLLECTOR_COMMIT": "a" * 40, "GITHUB_RUN_ID": "42", "GITHUB_RUN_ATTEMPT": "1",
                    "GITHUB_OUTPUT": str(workspace / "github-output"), "GITHUB_STEP_SUMMARY": str(workspace / "summary"),
                    "TF_PLAN_ENCRYPTION_CERT": cert.read_text(), "TERRAFORM_BIN": str(cli),
                }
                args = type("Args", (), {"environment": "staging"})()
                with patch.dict(os.environ, env), patch.object(release, "read_defaults", side_effect=lambda path: json.loads(path.read_text())):
                    release.plan(args)
                    ciphertext = (workspace / ".collector-release/release.enc").read_bytes()
                    self.assertNotIn(b"private value", ciphertext)
                    self.assertNotIn(b"collector-staging.example.com", ciphertext)
                    expected_hash = release.sha256(workspace / ".collector-release/release.enc")
                    # Apply starts on a fresh runner with only the encrypted artifact.
                    import shutil
                    shutil.rmtree(workspace / ".collector-release")
                    (workspace / ".collector-release").mkdir()
                    (workspace / ".collector-release/release.enc").write_bytes(ciphertext)
                    with patch.dict(os.environ, {"EXPECTED_CIPHERTEXT_SHA256": expected_hash, "TF_PLAN_DECRYPTION_KEY": key.read_text()}):
                        release.apply(args)
                    calls = [json.loads(line) for line in (workspace / "calls.jsonl").read_text().splitlines()]
                    self.assertEqual([call[0] for call in calls], ["init", "output", "plan", "show", "init", "apply", "output"])
                    self.assertEqual(calls[-2][-1], str((workspace / ".collector-release/tfplan").resolve()))
                    self.assertNotIn("-auto-approve", calls[-2])
                    self.assertNotIn("private value", (workspace / "summary").read_text())
                    self.assertIn("collector_project_id=prj_fixture", (workspace / "github-output").read_text())
                    # Changing even the checked-in configuration's byte snapshot
                    # invalidates the saved handoff before Terraform is invoked.
                    reviewed = (root / "variables.tf").read_text()
                    (root / "variables.tf").write_text(reviewed + "\n")
                    before = (workspace / "calls.jsonl").read_text()
                    with patch.dict(os.environ, {"EXPECTED_CIPHERTEXT_SHA256": expected_hash, "TF_PLAN_DECRYPTION_KEY": key.read_text()}):
                        with self.assertRaisesRegex(release.ReleaseError, "configuration differs"):
                            release.apply(args)
                    self.assertEqual((workspace / "calls.jsonl").read_text(), before)
                    (root / "variables.tf").write_text(reviewed)
                    # A stale-plan error halts Apply without replan or approval fallback.
                    with patch.dict(os.environ, {"EXPECTED_CIPHERTEXT_SHA256": expected_hash, "TF_PLAN_DECRYPTION_KEY": key.read_text(), "FIXTURE_STALE_PLAN": "1"}):
                        with self.assertRaises(release.ReleaseError):
                            release.apply(args)
                    final_calls = [json.loads(line) for line in (workspace / "calls.jsonl").read_text().splitlines()]
                    self.assertEqual([call[0] for call in final_calls[-2:]], ["init", "apply"])
                    self.assertNotIn("private stale-plan diagnostics", (workspace / "summary").read_text())
                    # A missing/modified artifact fails before any CLI calls.
                    (workspace / ".collector-release/release.enc").write_bytes(b"modified")
                    with patch.dict(os.environ, {"EXPECTED_CIPHERTEXT_SHA256": expected_hash, "TF_PLAN_DECRYPTION_KEY": key.read_text()}):
                        with self.assertRaises(ValueError):
                            release.apply(args)
            finally:
                os.chdir(previous)


if __name__ == "__main__":
    unittest.main()
