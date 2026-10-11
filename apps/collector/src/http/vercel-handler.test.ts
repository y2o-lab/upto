import { afterEach, beforeEach, expect, it, vi } from "vitest";

const dependencies = vi.hoisted(() => ({
  createDb: vi.fn(() => ({ fixture: true })),
  closeDb: vi.fn(async () => undefined),
  createNodeRuntime: vi.fn(),
  handler: vi.fn(async () => new Response("fixture", { status: 202 })),
}));
vi.mock("@upto/db", () => dependencies);
vi.mock("./runtime.js", () => ({ createNodeRuntime: dependencies.createNodeRuntime }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  dependencies.createNodeRuntime.mockImplementation(() => ({ handler: dependencies.handler }));
  vi.stubEnv("COLLECTOR_NODE_ENABLED", "false");
  vi.stubEnv("SLACK_BOT_TOKEN", "");
  vi.stubEnv("SLACK_CHANNEL_ID", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function enable() {
  const material = Buffer.from("fixture-key-material-not-a-secret-0001").toString("base64");
  for (const [name, value] of Object.entries({
    COLLECTOR_NODE_ENABLED: "true",
    COLLECTOR_ENVIRONMENT: "staging",
    COLLECTOR_EXECUTOR_VERSION: "1",
    COLLECTOR_CONFIG_VERSION: "1",
    COLLECTOR_PROMPT_VERSION: "1",
    COLLECTOR_SCHEMA_VERSION: "1",
    COLLECTOR_COUNT_VERSION: "1",
    COLLECTOR_CHUNKER_VERSION: "1",
    GEMINI_MODEL_PRIMARY: "fixture-primary",
    GEMINI_MODEL_FALLBACK: "fixture-fallback",
    GEMINI_API_KEY: "fixture-api-key",
    COLLECTOR_NODE_AUTH_KEYS: JSON.stringify({ fixture: material }),
    COLLECTOR_CURSOR_KEY: material,
    COLLECTOR_GATE_ORIGIN: "https://control.fixture.example",
    COLLECTOR_GATE_KEY_ID: "fixture",
    COLLECTOR_GATE_KEY: material,
    DATABASE_URL: "postgres://fixture:fixture@127.0.0.1:55439/upto_collector_test",
    COLLECTOR_DATABASE_POOL_MAX: "2",
  }))
    vi.stubEnv(name, value);
}
const request = () => new Request("https://fixture.example/api/v1/prepare");

it("imports and serves disabled requests without constructing a database or runtime", async () => {
  const { default: entry } = await import("./vercel-handler.js");
  expect(dependencies.createDb).not.toHaveBeenCalled();
  const response = await entry.fetch(request());
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ errorCode: "NODE_EXECUTION_DISABLED" });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-upto-request-id")).toBeTruthy();
  expect(dependencies.createDb).not.toHaveBeenCalled();
  expect(dependencies.createNodeRuntime).not.toHaveBeenCalled();
});
it("constructs one bounded runtime per instance and honors disable on warm requests", async () => {
  enable();
  const { default: entry } = await import("./vercel-handler.js");
  expect((await entry.fetch(request())).status).toBe(202);
  expect((await entry.fetch(request())).status).toBe(202);
  expect(dependencies.createDb).toHaveBeenCalledExactlyOnceWith(
    expect.any(String),
    expect.objectContaining({ max: 2 }),
  );
  expect(dependencies.createNodeRuntime).toHaveBeenCalledTimes(1);
  expect([...dependencies.createNodeRuntime.mock.calls[0]![0].feeds.keys()]).toEqual([
    "zenn",
    "qiita",
    "hatena-it",
    "hacker-news",
    "github-blog",
  ]);
  vi.stubEnv("COLLECTOR_NODE_ENABLED", "false");
  expect((await entry.fetch(request())).status).toBe(503);
  expect(dependencies.handler).toHaveBeenCalledTimes(2);
});
it("sanitizes initialization failures, closes the partial pool, and allows a clean retry", async () => {
  enable();
  dependencies.createNodeRuntime.mockImplementationOnce(() => {
    throw new Error("fixture-private-value");
  });
  const { default: entry } = await import("./vercel-handler.js");
  const failed = await entry.fetch(request());
  expect(failed.status).toBe(503);
  expect(await failed.text()).not.toContain("fixture-private-value");
  expect(dependencies.closeDb).toHaveBeenCalledTimes(1);
  expect((await entry.fetch(request())).status).toBe(202);
  expect(dependencies.createDb).toHaveBeenCalledTimes(2);
});
it("rejects malformed enable settings before opening a pool", async () => {
  vi.stubEnv("COLLECTOR_NODE_ENABLED", "fixture-private-value");
  const { default: entry } = await import("./vercel-handler.js");
  expect(await (await entry.fetch(request())).json()).toMatchObject({
    errorCode: "NODE_CONFIGURATION_INVALID",
  });
  expect(dependencies.createDb).not.toHaveBeenCalled();
});
it("wires the observer into the deployed runtime and awaits initialization alerts", async () => {
  enable();
  vi.stubEnv("SLACK_BOT_TOKEN", "xoxb-fixture");
  vi.stubEnv("SLACK_CHANNEL_ID", "C123ABC");
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetcher);
  dependencies.createNodeRuntime.mockImplementationOnce(() => {
    throw new Error("private-init-error");
  });
  const { default: entry } = await import("./vercel-handler.js");
  const response = await entry.fetch(request());
  expect(response.status).toBe(503);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0]![1]?.body)).toContain("NODE_CONFIGURATION_INVALID");
  expect(String(fetcher.mock.calls[0]![1]?.body)).not.toContain("private-init-error");
  expect((await entry.fetch(request())).status).toBe(202);
  expect(dependencies.createNodeRuntime.mock.calls[1]![0].observer).toBeTypeOf("function");
});
it("logs invalid Slack configuration but continues constructing the batch runtime", async () => {
  enable();
  vi.stubEnv("SLACK_BOT_TOKEN", "private-invalid-token");
  const lines: unknown[] = [];
  const log = vi.spyOn(console, "log").mockImplementation((line) => {
    lines.push(line);
  });
  try {
    const { default: entry } = await import("./vercel-handler.js");
    expect((await entry.fetch(request())).status).toBe(202);
    await dependencies.createNodeRuntime.mock.calls[0]![0].observer({
      event: "stage_finished",
      status: "succeeded",
    });
    expect(JSON.stringify(lines)).toContain("SLACK_CONFIGURATION_INVALID");
    expect(JSON.stringify(lines)).not.toContain("private-invalid-token");
  } finally {
    log.mockRestore();
  }
});
