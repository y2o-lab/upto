import hashlib
import hmac
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import collector_probe as probe


class ProbeTests(unittest.TestCase):
    def test_secret_value_must_not_enter_readback_plan_or_state(self):
        probe.check_secret_absent({"bindings": [{"name": "KEY", "type": "secret_text"}]}, "fixture-value")
        for value in [{"bindings": [{"text": "fixture-value"}]}, {"values": {"KEY": "fixture-value"}}]:
            with self.assertRaises(ValueError):
                probe.check_secret_absent(value, "fixture-value")

    def test_verify_proves_existing_key_after_upload_without_reinjecting(self):
        key = "fixture-only-bootstrap-key-with-at-least-43-characters"
        with tempfile.TemporaryDirectory() as directory:
            previous = Path.cwd()
            try:
                os.chdir(directory)
                folder = Path(".collector-release")
                folder.mkdir()
                (folder / "manifest.json").write_text(json.dumps({"environment": "staging", "bootstrap_phase": "ready"}))
                (folder / "config.tfvars.json").write_text(json.dumps({"cloudflare_account_id": "0" * 32, "workers_dev_subdomain": "fixture"}))
                (folder / "outputs.json").write_text(json.dumps({"gate_origin": {"value": "https://upto-collector-staging-control.fixture.workers.dev"}}))
                calls = []

                def http(url, headers=None, payload=None, method="GET"):
                    calls.append((url, method))
                    self.assertNotIn(key, url)
                    if url.endswith("/settings"):
                        return {"success": True, "result": {"bindings": [{"name": "COLLECTOR_BOOTSTRAP_PROBE_KEY", "type": "secret_text"}]}}
                    nonce = parse_qs(urlparse(url).query)["nonce"][0]
                    expected = hmac.new(key.encode(), f"request\n{nonce}".encode(), hashlib.sha256).hexdigest()
                    self.assertEqual(headers["x-bootstrap-signature"], expected)
                    return {"proof": hmac.new(key.encode(), f"response\n{nonce}".encode(), hashlib.sha256).hexdigest()}

                def cli(arguments, **kwargs):
                    if "show" in arguments:
                        value = {"resource_changes": [{"type": "cloudflare_workers_script", "change": {"actions": ["update"]}}]}
                    else:
                        value = {"resources": []}
                    return subprocess.CompletedProcess(arguments, 0, json.dumps(value).encode(), b"")

                event_file = Path(directory) / "event.json"
                event_file.write_text(json.dumps({"action": "closed", "pull_request": {"base": {"ref": "staging"}, "head": {"repo": {"full_name": "fixture/upto"}}, "merged": True, "merge_commit_sha": "a" * 40}}))
                env = {"GITHUB_REF": "refs/heads/staging", "GITHUB_EVENT_NAME": "pull_request", "GITHUB_EVENT_PATH": str(event_file), "GITHUB_SHA": "a" * 40, "COLLECTOR_COMMIT": "a" * 40, "GITHUB_REPOSITORY": "fixture/upto", "COLLECTOR_BOOTSTRAP_PROBE_KEY": key, "CLOUDFLARE_API_TOKEN": "fixture-api-token", "GITHUB_STEP_SUMMARY": str(Path(directory) / "summary")}
                with patch.dict(os.environ, env), patch.object(probe, "request_json", http), patch.object(probe.subprocess, "run", cli):
                    probe.run("verify")
                self.assertEqual([method for _, method in calls], ["GET", "GET"])
                self.assertNotIn(key, Path("summary").read_text())
            finally:
                os.chdir(previous)


if __name__ == "__main__":
    unittest.main()
