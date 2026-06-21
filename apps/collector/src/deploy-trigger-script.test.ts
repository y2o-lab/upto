import { spawnSync } from "node:child_process";
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

  it("rejects a host Docker socket without printing deployment secrets", () => {
    const result = spawnSync("sh", [script], {
      encoding: "utf8",
      env: {
        DOCKER_CERT_PATH: "/tmp/not-used",
        DOCKER_HOST: "unix:///var/run/docker.sock",
        DOCKER_TLS_VERIFY: "1",
        PATH: process.env.PATH,
        TRIGGER_ACCESS_TOKEN: "secret-access-token",
        TRIGGER_API_URL: "https://trigger.example.invalid",
        TRIGGER_DEPLOY_ENV: "staging",
        TRIGGER_PROJECT_REF: "proj_example",
        TRIGGER_REGISTRY_HOST: "registry.example.invalid",
        TRIGGER_REGISTRY_PASSWORD: "secret-registry-password",
        TRIGGER_REGISTRY_USERNAME: "upto-deployer",
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("A host Docker socket is not allowed");
    expect(result.stderr).not.toContain("secret-access-token");
    expect(result.stderr).not.toContain("secret-registry-password");
  });
});
