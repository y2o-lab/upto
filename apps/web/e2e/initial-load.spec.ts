import { expect, test } from "@playwright/test";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

function waitForMessage(child: ChildProcess, type: string): Promise<{ port: number | undefined }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Test server did not send ${type}`));
    }, 45_000);
    function cleanup() {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
    }
    function onMessage(message: unknown) {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === type
      ) {
        cleanup();
        resolve({
          port: "port" in message && typeof message.port === "number" ? message.port : undefined,
        });
      }
    }
    function onExit(code: number | null) {
      cleanup();
      reject(new Error(`Test server exited with code ${code}`));
    }
    function onError(error: Error) {
      cleanup();
      reject(error);
    }
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

test("shows the initial load error and recovers after the server becomes available", async ({
  page,
}) => {
  test.setTimeout(90_000);
  const child = fork(
    fileURLToPath(new URL("./support/initial-error-server.mjs", import.meta.url)),
    [],
    {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        DATABASE_URL: "",
        UPTO_WEB_USE_FIXTURE_DATA: "false",
        NEXT_TELEMETRY_DISABLED: "1",
      },
    },
  );
  let serverOutput = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream?.on("data", (chunk) => {
      serverOutput = (serverOutput + String(chunk)).slice(-4_000);
    });
  }
  try {
    const { port } = await waitForMessage(child, "ready");
    expect(port).toEqual(expect.any(Number));
    const url = `http://127.0.0.1:${port}`;
    await page.goto(url);
    await expect(page.getByRole("heading", { name: "記事を読み込めませんでした" })).toBeVisible();
    await expect(page.getByTestId("article-feed")).toHaveCount(0);
    const recovered = waitForMessage(child, "recovered");
    child.send("recover");
    await recovered;
    await page.getByRole("button", { name: "再読み込み", exact: true }).click();
    await expect(page.getByTestId("article-feed")).toHaveAttribute("data-ready", "true");
    await expect(page.locator("article[data-index='0'] h2")).toBeVisible();
    await expect(page.getByRole("heading", { name: "記事を読み込めませんでした" })).toHaveCount(0);
  } catch (error) {
    throw new Error(`Initial-load E2E failed. Test server output:\n${serverOutput}`, {
      cause: error,
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.kill("SIGTERM");
      const killTimeout = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await stopped;
      clearTimeout(killTimeout);
    }
  }
});
