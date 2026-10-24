import { describe, expect, it } from "vitest";

import {
  atCollectorStage,
  describeCollectorError,
  readFailureReport,
  serializeFailureReport,
} from "./collector-report.js";

describe("safe collector error reports", () => {
  it("preserves stages and HTTP status without raw exception details", async () => {
    let caught: unknown;
    try {
      await atCollectorStage("summarize", async () => {
        throw Object.assign(new Error("token=secret postgres://user:password@host/db"), {
          status: 429,
        });
      });
    } catch (error) {
      caught = error;
    }
    const details = describeCollectorError(caught);
    expect(details).toEqual({ stage: "summarize", kind: "rate_limit", httpStatus: 429 });
    expect(JSON.stringify(details)).not.toContain("secret");
  });

  it("survives Trigger.dev error serialization using a validated message payload", () => {
    const report = {
      durationMs: 50,
      issues: [{ stage: "execution" as const, kind: "unknown" as const }],
      metricsFailedCount: 0,
      skippedDuplicateCount: 0,
    };
    const message = serializeFailureReport(report);
    expect(readFailureReport({ name: "CollectorTaskError", message })).toEqual(report);
    expect(readFailureReport({ message: "postgres://password" })).toBeUndefined();
    expect(readFailureReport({ message: 'Collector task failed. {"issues":[]}' })).toBeUndefined();
  });
});
