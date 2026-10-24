import { beforeEach, describe, expect, it, vi } from "vitest";

import { serializeFailureReport } from "../notifications/collector-report.js";
import { notifyCollector } from "../notifications/slack.js";
import { collectNewsDefinition } from "./collect-news.js";

vi.mock("../notifications/slack.js", () => ({ notifyCollector: vi.fn(async () => undefined) }));

const ctx = {
  attempt: { number: 2, startedAt: new Date() },
  environment: { slug: "production" },
  run: { id: "run_hooks" },
};
const report = { durationMs: 50, issues: [], metricsFailedCount: 0, skippedDuplicateCount: 0 };

describe("collect-news notification hooks", () => {
  beforeEach(() => vi.clearAllMocks());

  it("notifies successful and partially failed runs through onSuccess", async () => {
    const output = {
      articleCount: 2,
      failedCount: 1,
      failedFeedCount: 0,
      feedCount: 1,
      successfulFeedCount: 1,
      dryRun: false,
      notificationReport: report,
    };
    const input = { output, ctx } as unknown as Parameters<
      NonNullable<typeof collectNewsDefinition.onSuccess>
    >[0];
    await collectNewsDefinition.onSuccess!(input);
    expect(notifyCollector).toHaveBeenCalledWith(
      {
        context: { attemptNumber: 2, environment: "production", runId: "run_hooks" },
        result: output,
        report,
      },
      expect.anything(),
    );
  });

  it("notifies final failures using the serialized safe report", async () => {
    const input = {
      error: { name: "CollectorTaskError", message: serializeFailureReport(report) },
      ctx,
    } as Parameters<NonNullable<typeof collectNewsDefinition.onFailure>>[0];
    await collectNewsDefinition.onFailure!(input);
    expect(notifyCollector).toHaveBeenCalledWith(
      {
        context: { attemptNumber: 2, environment: "production", runId: "run_hooks" },
        report,
      },
      expect.anything(),
    );
  });

  it("uses a safe fallback for unexpected framework errors", async () => {
    const input = { error: { message: "secret-db-url" }, ctx } as Parameters<
      NonNullable<typeof collectNewsDefinition.onFailure>
    >[0];
    await collectNewsDefinition.onFailure!(input);
    expect(JSON.stringify(vi.mocked(notifyCollector).mock.calls)).not.toContain("secret-db-url");
    expect(notifyCollector).toHaveBeenCalledWith(
      expect.objectContaining({
        report: expect.objectContaining({ issues: [{ stage: "execution", kind: "unknown" }] }),
      }),
      expect.anything(),
    );
  });
});
