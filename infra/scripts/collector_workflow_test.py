"""Contract checks for the secret-bearing workflow and its reusable release code."""
import json
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class WorkflowContractTests(unittest.TestCase):
    def setUp(self):
        self.workflow = (ROOT / ".github/workflows/terraform-collector.yml").read_text()
        self.plan = self.workflow.split("  plan:\n", 1)[1].split("  apply:\n", 1)[0]
        self.apply = self.workflow.split("  apply:\n", 1)[1]

    def test_forks_only_validate_without_credentials(self):
        self.assertNotIn("pull_request_target:", self.workflow)
        verify = self.workflow.split("  validate:\n", 1)[1].split("  plan:\n", 1)[0]
        self.assertNotIn("secrets.", verify)
        self.assertIn("needs: validate", self.plan)
        self.assertIn("github.event.pull_request.base.ref == 'staging'", self.plan)
        self.assertIn("github.event.pull_request.head.repo.full_name == github.repository", self.plan)
        self.assertIn("github.event.pull_request.merged == true", self.apply)
        self.assertIn("github.event.action == 'closed'", self.apply)
        self.assertIn("github.event_name == 'workflow_dispatch'", self.apply)
        self.assertIn("needs: [validate, plan]", self.apply)

    def test_shared_environment_with_job_specific_secret_injection(self):
        self.assertNotIn("TF_PLAN_DECRYPTION_KEY", self.plan)
        self.assertIn("TF_PLAN_ENCRYPTION_CERT", self.plan)
        self.assertIn("environment: terraform-collector-${{ github.event_name == 'pull_request' && 'staging' || 'production' }}", self.apply)
        self.assertIn("TF_PLAN_DECRYPTION_KEY", self.apply)
        shared = "environment: terraform-collector-${{ github.event_name == 'pull_request' && 'staging' || 'production' }}"
        self.assertEqual(self.workflow.count(shared + "\n"), 2)
        self.assertNotIn(shared + "-plan", self.workflow)
        self.assertNotIn(shared + "-apply", self.workflow)
        self.assertIn("path: .collector-release/release.enc", self.plan)
        self.assertIn("retention-days: 1", self.plan)
        self.assertNotIn("path: .collector-release\n", self.plan)

    def test_same_commit_run_attempt_and_state_lock(self):
        self.assertEqual(self.workflow.count("ref: ${{ env.COLLECTOR_COMMIT }}"), 3)
        artifact = "collector-plan-${{ github.run_id }}-${{ github.run_attempt }}"
        self.assertEqual(self.workflow.count(artifact), 2)
        self.assertIn("needs.plan.outputs.ciphertext_sha256", self.apply)
        self.assertIn("cancel-in-progress: false", self.workflow)
        self.assertIn("github.event.pull_request.merged == true && 'staging' || format('staging-pr-{0}', github.event.number)", self.workflow)
        for environment in ["staging", "production"]:
            backend = (ROOT / f"infra/environments/collector-{environment}/backend.tf").read_text()
            self.assertIn(f'key                         = "collector-{environment}/terraform.tfstate"', backend)
            self.assertIn("use_lockfile                = true", backend)
            self.assertNotIn('resource "', backend)

    def test_staging_is_pr_driven_without_direct_push_or_manual_apply(self):
        trigger = self.workflow.split("permissions:", 1)[0]
        self.assertIn("branches: [staging]", trigger)
        self.assertIn("types: [opened, synchronize, reopened, ready_for_review, closed]", trigger)
        self.assertNotIn("  push:", trigger)
        self.assertIn("  workflow_dispatch:", trigger)
        self.assertNotIn("branches: [staging, release-infra]", trigger)
        self.assertNotIn("      environment:", trigger)
        self.assertIn("github.event.pull_request.merge_commit_sha", self.workflow)
        self.assertNotIn("inputs.probe_action", self.workflow)
        self.assertIn("steps.apply.outputs.probe_action", self.apply)

    def test_saved_plan_only_and_cleanup(self):
        source = (ROOT / "infra/scripts/collector_release.py").read_text()
        self.assertIn('terraform(root, "apply", "-no-color", "-lock-timeout=5m", str((folder / "tfplan").resolve()))', source)
        self.assertNotIn('"-auto-approve"', source)
        self.assertEqual(self.workflow.count("if: always()"), 2)
        self.assertIn('"apps/collector/**"', self.workflow)
        self.assertIn('"packages/**"', self.workflow)
        self.assertIn('"pnpm-lock.yaml"', self.workflow)

    def test_functions_deploy_only_after_successful_saved_apply(self):
        verify = self.workflow.split("  validate:\n", 1)[1].split("  plan:\n", 1)[0]
        for check in ["pnpm install --frozen-lockfile", "pnpm --filter @upto/collector test", "pnpm --filter @upto/collector typecheck:vercel", "pnpm build:collector:node"]:
            self.assertIn(check, verify)
        self.assertNotIn("collector_deploy.py", self.plan)
        self.assertIn('python3 infra/scripts/collector_deploy.py "$COLLECTOR_ENVIRONMENT"', self.apply)
        self.assertLess(self.apply.index("collector_release.py apply"), self.apply.index("collector_deploy.py"))
        deploy = self.apply.split("      - name: Deploy stopped", 1)[1].split("      - name: Remove private", 1)[0]
        self.assertNotIn("if: always()", deploy)
        for setting in ["GEMINI_MODEL_PRIMARY", "GEMINI_MODEL_FALLBACK", "COLLECTOR_CHUNK_CHARS"]:
            self.assertIn(f"{setting}: ${{{{ vars.{setting} }}}}", deploy)
        self.assertIn("GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}", deploy)
        self.assertNotIn("GEMINI_API_KEY", self.plan)
        self.assertNotIn("GEMINI_API_KEY", self.apply.split("      - name: Deploy stopped", 1)[0])

    def test_one_cloudflare_token_per_environment_for_account_and_dns(self):
        self.assertEqual(self.workflow.count("CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}"), 2)
        self.assertNotIn("CLOUDFLARE_ACCOUNT_API_TOKEN", self.workflow)
        self.assertNotIn("CLOUDFLARE_DNS_API_TOKEN", self.workflow)
        self.assertNotIn("TF_VAR_cloudflare_dns_token", self.workflow)
        for environment in ["staging", "production"]:
            root = ROOT / f"infra/environments/collector-{environment}"
            providers = (root / "providers.tf").read_text()
            self.assertEqual(providers.count('provider "cloudflare"'), 1)
            self.assertNotIn('alias = "dns"', providers)
            self.assertNotIn("cloudflare.dns", (root / "main.tf").read_text())
            self.assertNotIn("api_token =", providers)
            self.assertNotIn('variable "cloudflare_dns_token"', (root / "variables.tf").read_text())

    def test_collector_git_deploys_disabled_and_build_settings_match(self):
        config = json.loads((ROOT / "apps/collector/vercel.json").read_text())
        module = (ROOT / "infra/modules/vercel-collector/main.tf").read_text()
        self.assertFalse(config["git"]["deploymentEnabled"])
        self.assertIsNone(config["framework"])
        self.assertIn(config["buildCommand"], module)
        self.assertIn(config["installCommand"], module)
        self.assertNotIn("git_repository =", module)
        self.assertIn("ignore_changes  = [environment]", module)


if __name__ == "__main__":
    unittest.main()
