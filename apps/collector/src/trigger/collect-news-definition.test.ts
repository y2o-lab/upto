import { describe, expect, it } from "vitest";

import { collectNews, collectNewsDefinition } from "./collect-news.js";

describe("collect-news Trigger.dev definition", () => {
  it("registers a serialized scheduled task with bounded retries", () => {
    expect(collectNews).toMatchObject({
      id: "collect-news",
    });
    expect(collectNewsDefinition).toMatchObject({
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
    });
  });
});
