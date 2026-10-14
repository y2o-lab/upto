import hashlib
import importlib.util
import json
import tempfile
import os
from unittest.mock import patch
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("release", Path(__file__).with_name("collector_release.py"))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseTests(unittest.TestCase):
    def test_only_release_ref_is_allowed(self):
        release.require_ref("refs/heads/release-infra", "workflow_dispatch")
        for ref, event in [("refs/heads/main", "workflow_dispatch"), ("refs/heads/release-infra", "pull_request"), ("refs/pull/1/merge", "pull_request_target")]:
            with self.assertRaises(ValueError):
                release.require_ref(ref, event)

    def test_staging_plan_and_apply_require_staging_pr_context(self):
        payload = {"action": "opened", "pull_request": {"base": {"ref": "staging"}, "head": {"repo": {"full_name": "fixture/upto"}}, "merged": False}}
        release.require_ref("refs/pull/7/merge", "pull_request", "staging", "plan", payload, "fixture/upto")
        with self.assertRaises(ValueError):
            release.require_ref("refs/pull/7/merge", "pull_request", "staging", "apply", payload, "fixture/upto")
        payload["action"] = "closed"
        payload["pull_request"]["merged"] = True
        release.require_ref("refs/heads/staging", "pull_request", "staging", "plan", payload, "fixture/upto")
        release.require_ref("refs/heads/staging", "pull_request", "staging", "apply", payload, "fixture/upto")
        for ref, event in [("refs/heads/staging", "push"), ("refs/heads/staging", "workflow_dispatch"), ("refs/heads/release-infra", "workflow_dispatch")]:
            with self.assertRaises(ValueError):
                release.require_ref(ref, event, "staging", "apply", payload, "fixture/upto")
        payload["pull_request"]["merged"] = False
        with self.assertRaises(ValueError):
            release.require_ref("refs/heads/staging", "pull_request", "staging", "apply", payload, "fixture/upto")

    def test_staging_rejects_wrong_base_and_fork(self):
        for base, head in [("main", "fixture/upto"), ("staging", "fork/upto")]:
            payload = {"action": "opened", "pull_request": {"base": {"ref": base}, "head": {"repo": {"full_name": head}}, "merged": False}}
            with self.assertRaises(ValueError):
                release.require_ref("refs/pull/7/merge", "pull_request", "staging", "plan", payload, "fixture/upto")

    def test_merged_release_binds_exact_merge_commit(self):
        with tempfile.TemporaryDirectory() as directory:
            event_file = Path(directory) / "event.json"
            event_file.write_text(json.dumps({"action": "closed", "pull_request": {"base": {"ref": "staging"}, "head": {"repo": {"full_name": "fixture/upto"}}, "merged": True, "merge_commit_sha": "a" * 40}}))
            env = {"GITHUB_REF": "refs/heads/staging", "GITHUB_EVENT_NAME": "pull_request", "GITHUB_EVENT_PATH": str(event_file), "GITHUB_REPOSITORY": "fixture/upto", "GITHUB_SHA": "b" * 40, "COLLECTOR_COMMIT": "a" * 40}
            with patch.dict(os.environ, env):
                self.assertEqual(release.require_context("staging", "apply"), "a" * 40)
                with patch.dict(os.environ, {"COLLECTOR_COMMIT": "b" * 40}):
                    with self.assertRaises(ValueError):
                        release.require_context("staging", "apply")

    def test_staging_release_settings_are_reviewable_and_bounded(self):
        release.require_staging_release({"bootstrap_phase": "worker", "probe_action": "inject"})
        release.require_staging_release({"bootstrap_phase": "ready", "probe_action": "verify"})
        for value in [{"bootstrap_phase": "foundation", "probe_action": "inject"}, {"bootstrap_phase": "worker", "probe_action": "verify"}, {"bootstrap_phase": "ready", "probe_action": "none", "secret": "bad"}]:
            with self.assertRaises(ValueError):
                release.require_staging_release(value)

    def test_phase_cannot_go_back_or_skip(self):
        for old, new in [("ready", "workflows"), ("workflows", "worker"), ("foundation", "ready")]:
            with self.assertRaises(ValueError):
                release.require_phase(old, new)
        for old, new in [(None, "foundation"), ("foundation", "worker"), ("worker", "workflows"), ("workflows", "ready"), ("ready", "ready")]:
            release.require_phase(old, new)

    def test_stopped_bundle_cannot_be_activated(self):
        for settings in [{"consumer_enabled": True}, {"control_mode": "active"}, {"collection_crons": ["0 * * * *"]}, {"maintenance_crons": ["*/5 * * * *"]}, {"runtime_verified": True}]:
            with self.assertRaises(ValueError):
                release.require_bootstrap(settings)
        release.require_bootstrap({"bootstrap_phase": "ready", "control_mode": "paused"})

    def test_plan_rejects_destroy_and_noncollector_resources(self):
        valid = {"resource_changes": [{"address": "module.cloudflare_collector.cloudflare_d1_database.control", "mode": "managed", "type": "cloudflare_d1_database", "change": {"actions": ["create"]}}]}
        self.assertEqual(release.summarize_plan(valid), ["module.cloudflare_collector.cloudflare_d1_database.control: create"])
        for change in [
            {"address": "module.cloudflare_collector.cloudflare_d1_database.control", "mode": "managed", "type": "cloudflare_d1_database", "change": {"actions": ["delete", "create"]}},
            {"address": "module.web.vercel_project.web", "mode": "managed", "type": "vercel_project", "change": {"actions": ["update"]}},
            {"address": "module.cloudflare_collector.cloudflare_r2_bucket.state", "mode": "managed", "type": "cloudflare_r2_bucket", "change": {"actions": ["create"]}},
        ]:
            with self.assertRaises(ValueError):
                release.summarize_plan({"resource_changes": [change]})

    def test_manifest_binds_commit_environment_run_and_every_file(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in release.PAYLOAD_FILES:
                (root / name).write_text(name)
            manifest = release.make_manifest(root, "a" * 40, "staging", "42", "1", "worker")
            release.verify_manifest(root, manifest, "a" * 40, "staging", "42", "1")
            for commit, environment, run, attempt in [("b" * 40, "staging", "42", "1"), ("a" * 40, "production", "42", "1"), ("a" * 40, "staging", "43", "1"), ("a" * 40, "staging", "42", "2")]:
                with self.assertRaises(ValueError):
                    release.verify_manifest(root, manifest, commit, environment, run, attempt)
            (root / "control.mjs").write_text("changed")
            with self.assertRaises(ValueError):
                release.verify_manifest(root, manifest, "a" * 40, "staging", "42", "1")

    def test_configuration_is_loaded_from_reviewed_terraform_files(self):
        config = {"cloudflare_account_id": "0" * 32, "cloudflare_zone_id": "1" * 32, "collector_domain": "collector-staging.example.com", "dns_record_name": "collector-staging", "workers_dev_subdomain": "fixture", "vercel_org_id": "user_fixture", "bootstrap_probe_action": "inject", "settings": {"bootstrap_phase": "worker"}}
        with tempfile.TemporaryDirectory() as directory:
            staging = Path(directory) / "staging.json"
            production = Path(directory) / "production.json"
            staging.write_text(json.dumps(config))
            production.write_text(json.dumps({**config, "collector_domain": "collector.example.com"}))
            with patch.object(release, "configuration_path", side_effect=lambda env: staging if env == "staging" else production), patch.object(release, "read_defaults", side_effect=lambda path: json.loads(path.read_text())), patch.dict(os.environ, {"COLLECTOR_TF_CONFIG": "not used", "COLLECTOR_PEER_DOMAIN": "not used"}):
                actual, settings, peer = release.load_configuration("staging")
                self.assertEqual(actual, config)
                self.assertEqual(settings, {"bootstrap_phase": "worker", "probe_action": "inject"})
                self.assertEqual(peer, "production")
                with self.assertRaises(ValueError):
                    release.load_configuration("production")
                production.write_text(json.dumps({**config, "collector_domain": config["collector_domain"]}))
                with self.assertRaises(ValueError):
                    release.load_configuration("staging")
                production.write_text(json.dumps({**config, "DATABASE_URL": "must not be accepted"}))
                with self.assertRaises(ValueError):
                    release.load_configuration("staging")

    @unittest.skipUnless(os.environ.get("TERRAFORM_BIN") or __import__("shutil").which("terraform"), "Terraform CLI required")
    def test_native_terraform_evaluates_hcl_defaults_without_env_overrides(self):
        defaults = {name: "" for name in release.CONFIG_FIELDS}
        defaults.update({"cloudflare_account_id": "0" * 32, "cloudflare_zone_id": "1" * 32, "collector_domain": "collector-staging.example.com", "dns_record_name": "collector-staging", "workers_dev_subdomain": "fixture", "dns_record_type": "CNAME", "compatibility_flags": [], "verification_dns_records": {}, "bootstrap_probe_action": "none"})
        defaults.pop("settings")
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "variables.tf"
            lines = [f'variable "{name}" {{ default = {json.dumps(value)} }}' for name, value in defaults.items()]
            lines.append('variable "settings" { default = { bootstrap_phase = "foundation", control_mode = "paused" } }')
            lines.append('variable "unused_pending_id" {\n default = ""\n validation {\n condition = length(var.unused_pending_id) > 0\n error_message = "Pending ID."\n }\n}')
            path.write_text("\n".join(lines))
            (Path(directory) / "terraform.tfvars").write_text('collector_domain = "wrong.example.com"')
            with patch.dict(os.environ, {"TF_VAR_collector_domain": "wrong.example.com", "TF_CLI_ARGS_console": "-var=collector_domain=wrong.example.com"}):
                result = release.read_defaults(path)
            self.assertEqual(result["collector_domain"], defaults["collector_domain"])
            self.assertEqual(result["settings"]["bootstrap_phase"], "foundation")

    def test_config_excludes_secrets_and_overrides(self):
        base = {"cloudflare_account_id": "0" * 32, "cloudflare_zone_id": "1" * 32, "collector_domain": "collector-staging.example.com", "dns_record_name": "collector-staging", "workers_dev_subdomain": "fixture"}
        release.require_config(base, "staging", "collector-production.example.com")
        for field in ["DATABASE_URL", "cloudflare_dns_token", "bundle_path", "bundle_sha256"]:
            with self.assertRaises(ValueError):
                release.require_config({**base, field: "value"}, "staging", "collector-production.example.com")
        with self.assertRaises(ValueError):
            release.require_config(base, "staging", base["collector_domain"])
        for peer in ["TODO", "", "not-a-domain"]:
            with self.assertRaises(ValueError):
                release.require_config(base, "staging", peer)


if __name__ == "__main__":
    unittest.main()
