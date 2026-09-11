import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(
  new URL("../scripts/diagnose-migration-connection.mjs", import.meta.url),
);

async function runDiagnostic(directDatabaseUrl?: string) {
  try {
    await execFileAsync(process.execPath, [scriptPath], {
      env: {
        ...process.env,
        DIRECT_DATABASE_URL: directDatabaseUrl,
      },
    });
    throw new Error("Expected the diagnostic to fail.");
  } catch (error) {
    return error as { code: number; stderr: string };
  }
}

describe("migration connection diagnostic", () => {
  it("reports a missing migration URL as a GitHub Actions error annotation", async () => {
    const error = await runDiagnostic();

    expect(error.code).toBe(1);
    expect(error.stderr).toContain(
      "::error title=Supabase migration configuration failed::DIRECT_DATABASE_URL is not configured",
    );
  });

  it("does not echo an invalid migration URL", async () => {
    const invalidUrl = "not-a-postgres-url-with-password";
    const error = await runDiagnostic(invalidUrl);

    expect(error.code).toBe(1);
    expect(error.stderr).toContain("DIRECT_DATABASE_URL is not a valid PostgreSQL connection URL.");
    expect(error.stderr).not.toContain(invalidUrl);
  });
});
