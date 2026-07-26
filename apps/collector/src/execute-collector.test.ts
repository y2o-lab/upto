import { describe, expect, it, vi } from "vitest";

import type { RunCollectorInput, RunCollectorResult } from "./run-collector.js";

import { CollectorExecutionError, executeCollector } from "./execute-collector.js";

const feed = {
  kind: "rss" as const,
  name: "Example",
  siteUrl: "https://example.com",
  url: "https://example.com/feed.xml",
};

describe("executeCollector", () => {
  it("reads configuration and passes injected dependencies to the collector", async () => {
    const logger = vi.fn();
    const expectedResult: RunCollectorResult = {
      articleCount: 1,
      dryRun: false,
      failedCount: 0,
      failedFeedCount: 0,
      feedCount: 1,
      successfulFeedCount: 1,
    };
    const runner = vi.fn(async (_input: RunCollectorInput) => expectedResult);

    const result = await executeCollector({
      dependencies: { logger },
      environment: {
        COLLECTOR_CONCURRENCY: "1",
        COLLECTOR_DRY_RUN: "false",
        COLLECTOR_MAX_ITEMS_PER_FEED: "2",
        DATABASE_URL: "postgres://example.invalid/upto",
        GEMINI_API_KEY: "test-key",
      },
      feeds: [feed],
      runner,
    });

    expect(result).toBe(expectedResult);
    expect(runner).toHaveBeenCalledOnce();
    expect(runner).toHaveBeenCalledWith({
      config: expect.objectContaining({
        concurrency: 1,
        dryRun: false,
        maxItemsPerFeed: 2,
      }),
      dependencies: { logger },
      feeds: [feed],
    });
  });

  it("fails the execution when no feed could be fetched", async () => {
    const runner = vi.fn(
      async (): Promise<RunCollectorResult> => ({
        articleCount: 0,
        dryRun: false,
        failedCount: 1,
        failedFeedCount: 1,
        feedCount: 1,
        successfulFeedCount: 0,
      }),
    );

    await expect(
      executeCollector({
        environment: {
          COLLECTOR_DRY_RUN: "false",
          DATABASE_URL: "postgres://example.invalid/upto",
          GEMINI_API_KEY: "test-key",
        },
        feeds: [feed],
        runner,
      }),
    ).rejects.toBeInstanceOf(CollectorExecutionError);
  });

  it("keeps a partial failure as a completed execution", async () => {
    const expectedResult: RunCollectorResult = {
      articleCount: 1,
      dryRun: false,
      failedCount: 1,
      failedFeedCount: 0,
      feedCount: 1,
      successfulFeedCount: 1,
    };

    await expect(
      executeCollector({
        environment: {
          COLLECTOR_DRY_RUN: "false",
          DATABASE_URL: "postgres://example.invalid/upto",
          GEMINI_API_KEY: "test-key",
        },
        feeds: [feed],
        runner: async () => expectedResult,
      }),
    ).resolves.toBe(expectedResult);
  });
});
