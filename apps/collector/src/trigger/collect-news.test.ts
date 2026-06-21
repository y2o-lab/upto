import { describe, expect, it, vi } from "vitest";

import type { RunCollectorResult } from "../run-collector.js";

import {
  CollectorTaskError,
  executeCollectNewsTask,
  type TriggerTaskLogger,
} from "./collect-news-runner.js";

function createLogger() {
  return {
    error: vi.fn<TriggerTaskLogger["error"]>(),
    info: vi.fn<TriggerTaskLogger["info"]>(),
    warn: vi.fn<TriggerTaskLogger["warn"]>(),
  };
}

describe("executeCollectNewsTask", () => {
  it("returns the collector result and includes run context in structured logs", async () => {
    const logger = createLogger();
    const result: RunCollectorResult = {
      articleCount: 2,
      dryRun: false,
      failedCount: 0,
      failedFeedCount: 0,
      feedCount: 1,
      successfulFeedCount: 1,
    };
    const execute = vi.fn(async () => result);

    await expect(
      executeCollectNewsTask({
        attemptNumber: 1,
        execute,
        logger,
        now: sequenceClock(1_000, 1_250),
        runId: "run_123",
      }),
    ).resolves.toBe(result);

    expect(execute).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith("Collector run started", {
      attemptNumber: 1,
      runId: "run_123",
    });
    expect(logger.info).toHaveBeenCalledWith("Collector run completed", {
      ...result,
      attemptNumber: 1,
      durationMs: 250,
      runId: "run_123",
    });
  });

  it("logs a partial failure as a warning without failing the task", async () => {
    const logger = createLogger();
    const result: RunCollectorResult = {
      articleCount: 1,
      dryRun: false,
      failedCount: 1,
      failedFeedCount: 0,
      feedCount: 1,
      successfulFeedCount: 1,
    };

    await expect(
      executeCollectNewsTask({
        attemptNumber: 2,
        execute: async () => result,
        logger,
        now: sequenceClock(100, 150),
        runId: "run_partial",
      }),
    ).resolves.toBe(result);

    expect(logger.warn).toHaveBeenCalledWith("Collector run completed with errors", {
      ...result,
      attemptNumber: 2,
      durationMs: 50,
      runId: "run_partial",
    });
  });

  it("removes secrets, error details, article URLs, and content from collector events", async () => {
    const logger = createLogger();

    await executeCollectNewsTask({
      attemptNumber: 1,
      execute: async (executionInput) => {
        executionInput?.dependencies?.logger?.({
          apiKey: "secret-api-key",
          contentText: "private article body",
          databaseUrl: "postgres://user:password@database.internal/upto",
          error: "request failed with token secret-token",
          feed: "Example",
          fetchedCount: 1,
          jobId: "job-123",
          normalizedUrl: "https://example.com/private",
          status: "article_failed",
          url: "https://example.com/private?token=secret-token",
        });

        return {
          articleCount: 0,
          dryRun: false,
          failedCount: 1,
          failedFeedCount: 0,
          feedCount: 1,
          successfulFeedCount: 1,
        };
      },
      logger,
      runId: "run_safe",
    });

    const serializedLogs = JSON.stringify([
      logger.error.mock.calls,
      logger.info.mock.calls,
      logger.warn.mock.calls,
    ]);
    expect(serializedLogs).not.toContain("secret-api-key");
    expect(serializedLogs).not.toContain("private article body");
    expect(serializedLogs).not.toContain("password");
    expect(serializedLogs).not.toContain("secret-token");
    expect(serializedLogs).not.toContain("https://example.com/private");
    expect(logger.warn).toHaveBeenCalledWith("Collector event", {
      attemptNumber: 1,
      feed: "Example",
      fetchedCount: 1,
      jobId: "job-123",
      runId: "run_safe",
      status: "article_failed",
    });
  });

  it("logs only a safe error category and throws a generic fatal error", async () => {
    const logger = createLogger();

    await expect(
      executeCollectNewsTask({
        attemptNumber: 1,
        execute: async () => {
          throw new Error("postgres://user:password@database.internal/upto");
        },
        logger,
        runId: "run_failed",
      }),
    ).rejects.toEqual(new CollectorTaskError());

    expect(logger.error).toHaveBeenCalledWith("Collector run failed", {
      attemptNumber: 1,
      errorType: "Error",
      runId: "run_failed",
    });
    expect(
      JSON.stringify([logger.error.mock.calls, logger.info.mock.calls, logger.warn.mock.calls]),
    ).not.toContain("password");
  });
});

function sequenceClock(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}
