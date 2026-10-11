import { describe, expect, it } from "vitest";

import { stageRequestSchema } from "./contracts.js";
import { finalizationCountsSchema } from "./finalization.js";
it("rejects an HTTP count version that overflows the PG projection column", () => {
  const request = {
    apiVersion: "v1",
    environment: "staging",
    jobId: "00000000-0000-4000-8000-000000000001",
    workId: "00000000-0000-4000-8000-000000000001",
    operationKey: "a".repeat(64),
    executorVersion: "1",
    configVersion: "1",
    deadlineAt: "2026-10-11T00:00:00Z",
    stage: "job-finalize",
    countVersion: 2147483647,
    counts: { fetched: 0, succeeded: 0, failed: 0, cancelled: 0 },
  };
  expect(stageRequestSchema.safeParse(request).success).toBe(true);
  expect(stageRequestSchema.safeParse({ ...request, countVersion: 2147483648 }).success).toBe(
    false,
  );
});
describe("job count bounds", () => {
  it("accepts skipped candidates but rejects inflated and PG-overflow counts", () => {
    expect(
      finalizationCountsSchema.safeParse({ fetched: 3, succeeded: 1, failed: 0, cancelled: 0 })
        .success,
    ).toBe(true);
    expect(
      finalizationCountsSchema.safeParse({ fetched: 1, succeeded: 1, failed: 1, cancelled: 0 })
        .success,
    ).toBe(false);
    expect(
      finalizationCountsSchema.safeParse({
        fetched: 2147483648,
        succeeded: 0,
        failed: 0,
        cancelled: 0,
      }).success,
    ).toBe(false);
  });
});
