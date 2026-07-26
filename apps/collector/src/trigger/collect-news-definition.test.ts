import { describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
  task: vi.fn((definition: unknown) => definition),
}));

vi.mock("@trigger.dev/sdk", () => ({
  logger: sdk.logger,
  schedules: {
    task: sdk.task,
  },
}));

await import("./collect-news.js");

describe("collect-news Trigger.dev definition", () => {
  it("registers a serialized scheduled task with bounded retries", () => {
    expect(sdk.task).toHaveBeenCalledOnce();
    expect(sdk.task).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "collect-news",
        maxDuration: 7_200,
        queue: {
          concurrencyLimit: 1,
        },
        retry: {
          factor: 2,
          maxAttempts: 2,
          maxTimeoutInMs: 300_000,
          minTimeoutInMs: 30_000,
          randomize: true,
        },
        run: expect.any(Function),
      }),
    );
  });
});
