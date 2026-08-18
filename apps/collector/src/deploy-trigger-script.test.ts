import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../scripts/deploy-trigger.sh", import.meta.url));

describe("deploy-trigger.sh", () => {
  it("fails before deployment when required variables are missing", () => {
    const result = spawnSync("sh", [script], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Required deployment variable is missing: TRIGGER_API_URL");
  });

  it("uses the local Docker daemon without requiring remote TLS settings", () => {
    const binDirectory = mkdtempSync(join(tmpdir(), "upto-deploy-script-bin-"));
    const logPath = join(binDirectory, "commands.log");

    try {
      writeFileSync(logPath, "");

      const dockerPath = join(binDirectory, "docker");
      writeFileSync(
        dockerPath,
        `#!/bin/sh
printf 'docker:%s:%s:%s:%s\\n' "$1" "\${DOCKER_HOST-unset}" "\${DOCKER_TLS_VERIFY-unset}" "\${DOCKER_CERT_PATH-unset}" >> "$DEPLOY_TEST_LOG"
`,
      );
      chmodSync(dockerPath, 0o755);

      const pnpmPath = join(binDirectory, "pnpm");
      writeFileSync(
        pnpmPath,
        `#!/bin/sh
printf 'pnpm:%s\\n' "$*" >> "$DEPLOY_TEST_LOG"
`,
      );
      chmodSync(pnpmPath, 0o755);

      const result = spawnSync("sh", [script], {
        encoding: "utf8",
        env: {
          DEPLOY_TEST_LOG: logPath,
          DOCKER_CERT_PATH: "/tmp/not-used",
          DOCKER_HOST: "tcp://remote.example.invalid:2376",
          DOCKER_TLS_VERIFY: "1",
          PATH: `${binDirectory}:${process.env.PATH}`,
          TRIGGER_ACCESS_TOKEN: "secret-access-token",
          TRIGGER_API_URL: "https://trigger.example.invalid",
          TRIGGER_DEPLOY_ENV: "staging",
          TRIGGER_PROJECT_REF: "proj_example",
          TRIGGER_REGISTRY_HOST: "registry.example.invalid",
          TRIGGER_REGISTRY_PASSWORD: "secret-registry-password",
          TRIGGER_REGISTRY_USERNAME: "upto-deployer",
        },
      });

      const commandLog = readFileSync(logPath, "utf8");

      expect(result.status).toBe(0);
      expect(commandLog).toContain("docker:version:unset:unset:unset");
      expect(commandLog).toContain("docker:login:unset:unset:unset");
      expect(commandLog).toContain("pnpm:trigger:deploy:dry-run");
      expect(commandLog).toContain("pnpm:trigger:deploy:staging");
      expect(result.stdout).not.toContain("secret-access-token");
      expect(result.stdout).not.toContain("secret-registry-password");
    } finally {
      rmSync(binDirectory, { force: true, recursive: true });
    }
  });
});
