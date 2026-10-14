"""Deployment orchestration: exact source, project scope, stopped runtime, private logs."""
import json
import os
import subprocess
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch

from collector_deploy import deploy, deployment_command, run_private, collector_environment, sync_collector_environment
from collector_release import ReleaseError


class DeploymentTests(unittest.TestCase):
    def test_gemini_settings_are_required_and_model_names_validated(self):
        settings = {"GEMINI_MODEL_PRIMARY": "fixture-primary", "GEMINI_MODEL_FALLBACK": "fixture-fallback", "GEMINI_API_KEY": "fixture-api-key"}
        self.assertEqual(len(collector_environment(settings)), 4)
        self.assertEqual(collector_environment(settings)[-1]["value"], "12000")
        self.assertEqual(collector_environment({**settings, "COLLECTOR_CHUNK_CHARS": "24000"})[-1]["value"], "24000")
        for value in ["0", "999", "100001", "1.5", "invalid", ""]:
            with self.subTest(chunk=value), self.assertRaises(ReleaseError):
                collector_environment({**settings, "COLLECTOR_CHUNK_CHARS": value})
        for name in settings:
            with self.subTest(name=name), self.assertRaises(ReleaseError):
                collector_environment({**settings, name: ""})
        with self.assertRaises(ReleaseError):
            collector_environment({**settings, "GEMINI_MODEL_PRIMARY": "invalid model"})

    @patch("collector_deploy.http.client.HTTPSConnection")
    def test_upsert_uses_saved_project_scope_sensitive_key_and_production_target(self, connection):
        settings = collector_environment({"GEMINI_MODEL_PRIMARY": "fixture-primary", "GEMINI_MODEL_FALLBACK": "fixture-fallback", "GEMINI_API_KEY": "fixture-api-key"})
        client = connection.return_value
        response = client.getresponse.return_value
        response.status = 200
        response.read.side_effect = [json.dumps({"created": entry, "failed": []}).encode() for entry in settings]
        sync_collector_environment("prj_saved", "team_saved", "fixture-token", settings)
        connection.assert_called_once_with("api.vercel.com", timeout=30)
        self.assertEqual(client.request.call_count, 4)
        for call, entry in zip(client.request.call_args_list, settings):
            self.assertEqual(call.args[:2], ("POST", "/v10/projects/prj_saved/env?upsert=true&teamId=team_saved"))
            self.assertEqual(json.loads(call.kwargs["body"]), entry)
            self.assertEqual(entry["target"], ["production"])
            self.assertEqual(entry["type"], "sensitive" if entry["key"] == "GEMINI_API_KEY" else "plain")
        client.close.assert_called_once()

    @patch("collector_deploy.http.client.HTTPSConnection")
    def test_personal_project_omits_team_scope(self, connection):
        entry = {"key": "GEMINI_API_KEY", "value": "fixture-api-key", "type": "sensitive", "target": ["production"]}
        response = connection.return_value.getresponse.return_value
        response.status = 200
        response.read.return_value = json.dumps({"created": entry, "failed": []}).encode()
        sync_collector_environment("prj_saved", "user_saved", "fixture-token", [entry])
        self.assertEqual(connection.return_value.request.call_args.args[1], "/v10/projects/prj_saved/env?upsert=true")

    @patch("collector_deploy.http.client.HTTPSConnection")
    def test_api_failure_redirect_or_partial_success_is_private_and_not_retried(self, connection):
        entry = {"key": "GEMINI_API_KEY", "value": "fixture-api-key", "type": "sensitive", "target": ["production"]}
        for status, body in [(403, b"fixture-api-key"), (307, b"redirect"), (200, b'{"failed":[{"error":"fixture-api-key"}]}'), (200, b'{}'), (200, b'not-json')]:
            client = connection.return_value
            client.reset_mock()
            client.getresponse.return_value.status = status
            client.getresponse.return_value.read.side_effect = None
            client.getresponse.return_value.read.return_value = body
            with self.subTest(status=status, body=body), self.assertRaises(ReleaseError) as failure:
                sync_collector_environment("prj_saved", "team_saved", "fixture-token", [entry])
            self.assertNotIn("fixture-api-key", str(failure.exception))
            self.assertEqual(client.request.call_count, 1)
            client.close.assert_called_once()

    def test_deploy_uses_terraform_project_and_forces_disabled_runtime(self):
        command, env = deployment_command("staging", "a" * 40, "prj_collector", "team_scope", "private-token")
        self.assertEqual(command[:5], ["pnpm", "dlx", "vercel@59.15.0", "deploy", "--prod"])
        self.assertIn("--yes", command)
        self.assertIn("COLLECTOR_NODE_ENABLED=false", command)
        self.assertIn("COLLECTOR_ENVIRONMENT=staging", command)
        self.assertIn("collectorCommit=" + "a" * 40, command)
        self.assertEqual(env["VERCEL_PROJECT_ID"], "prj_collector")
        self.assertEqual(env["VERCEL_ORG_ID"], "team_scope")
        self.assertNotIn("--logs", command)
        self.assertNotIn("--no-wait", command)
        self.assertNotIn("AWS_SECRET_ACCESS_KEY", env)
        self.assertNotIn("TF_PLAN_DECRYPTION_KEY", env)

    def test_invalid_scope_or_missing_token_stops_before_cli(self):
        for project, org, token in [("", "team_scope", "token"), ("prj_x", "", "token"), ("prj_x", "team_x", "")]:
            with self.assertRaises(ReleaseError):
                deployment_command("staging", "a" * 40, project, org, token)

    def test_registration_failure_stops_before_source_upload(self):
        commit = "a" * 40
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            (folder / "manifest.json").write_text(json.dumps({"commit": commit, "environment": "staging"}))
            (folder / "config.tfvars.json").write_text(json.dumps({"vercel_team_id": "team_saved"}))
            (folder / "outputs.json").write_text(json.dumps({"collector_project_id": {"value": "prj_saved"}}))
            with patch("collector_deploy.require_context", return_value=commit), patch("collector_deploy.sync_collector_environment", side_effect=ReleaseError("registration failed")), patch("collector_deploy.run_private") as cli, patch.dict(os.environ, {"VERCEL_API_TOKEN": "fixture-token", "GEMINI_MODEL_PRIMARY": "fixture-primary", "GEMINI_MODEL_FALLBACK": "fixture-fallback", "GEMINI_API_KEY": "fixture-api-key"}):
                with self.assertRaises(ReleaseError):
                    deploy("staging", folder)
                cli.assert_not_called()

    def test_archive_uses_exact_commit_and_excludes_runner_private_files(self):
        # Real read-only git archive/tar; intercept only the external deployment.
        commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
        original_run = run_private
        destinations = []
        expected_owner = "team_saved"
        def intercept(command, **kwargs):
            if command[0] != "pnpm":
                return original_run(command, **kwargs)
            source = Path(kwargs["cwd"])
            destinations.append(source)
            self.assertTrue((source / "pnpm-lock.yaml").is_file())
            self.assertTrue((source / "apps/collector/vercel.json").is_file())
            self.assertFalse((source / ".collector-release").exists())
            self.assertFalse((source / "node_modules").exists())
            self.assertFalse((source / ".git").exists())
            self.assertIn("collectorCommit=" + commit, command)
            self.assertEqual(kwargs["env"]["VERCEL_ORG_ID"], expected_owner)
            return b"Packages: +1\nhttps://collector-example.vercel.app\n"
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            (folder / "manifest.json").write_text(json.dumps({"commit": commit, "environment": "staging"}))
            (folder / "config.tfvars.json").write_text(json.dumps({"vercel_team_id": "team_saved"}))
            (folder / "outputs.json").write_text(json.dumps({"collector_project_id": {"value": "prj_saved"}}))
            with patch("collector_deploy.require_context", return_value=commit), patch("collector_deploy.sync_collector_environment") as sync, patch("collector_deploy.run_private", side_effect=intercept), patch.dict(os.environ, {"VERCEL_API_TOKEN": "private-token", "VERCEL_ORG_ID": "team_wrong", "GEMINI_MODEL_PRIMARY": "fixture-primary", "GEMINI_MODEL_FALLBACK": "fixture-fallback", "GEMINI_API_KEY": "fixture-api-key", "GITHUB_STEP_SUMMARY": str(folder / "summary"), "GITHUB_OUTPUT": str(folder / "output")}):
                deploy("staging", folder)
                self.assertEqual(sync.call_args.args[:3], ("prj_saved", "team_saved", "private-token"))
                self.assertNotIn("GEMINI_API_KEY", deployment_command("staging", commit, "prj_saved", "team_saved", "private-token")[1])
                expected_owner = "user_saved"
                (folder / "config.tfvars.json").write_text(json.dumps({"vercel_team_id": "", "vercel_org_id": "user_saved"}))
                deploy("staging", folder)
                self.assertEqual(sync.call_args.args[1], "user_saved")
            self.assertIn(commit, (folder / "summary").read_text())
            self.assertNotIn("private-token", (folder / "summary").read_text())
            self.assertFalse(destinations[0].exists())

    @patch("collector_deploy.subprocess.run")
    def test_failed_cli_does_not_expose_output_or_retry(self, run):
        run.return_value = subprocess.CompletedProcess([], 1, b"private-token", b"DATABASE_URL=private")
        with self.assertRaisesRegex(ReleaseError, "Vercel deployment command failed") as failure:
            run_private(["deploy"], env={})
        self.assertNotIn("private", str(failure.exception))
        self.assertEqual(run.call_count, 1)
        self.assertTrue(run.call_args.kwargs["capture_output"])


if __name__ == "__main__":
    unittest.main()
