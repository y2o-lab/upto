import { describe, expect, it } from "vitest";

import {
  stageRequestSchema,
  manifestQuerySchema,
  operationStatusSchema,
  stageResponseSchema,
  gateRequestSchema,
} from "./contracts.js";
import { classifyFailure, retryDecision } from "./error-policy.js";
import { operationKey, workflowInstanceId } from "./operation-key.js";
import { canTransitionWork, transitionWork, aggregateJobStatus } from "./state-machine.js";

const id = "00000000-0000-4000-8000-000000000001";
const hash = "a".repeat(64);
const common = {
  apiVersion: "v1",
  environment: "staging",
  jobId: id,
  workId: id,
  operationKey: hash,
  executorVersion: "build-1",
  configVersion: "config-1",
  deadlineAt: "2026-10-11T00:00:00Z",
};
const stages = [
  { stage: "discovery", feedId: "hn", scheduledAt: common.deadlineAt, maxItems: 20 },
  { stage: "extract", candidateId: id, generationId: id },
  { stage: "summarize-chunk", generationId: id, chunkId: id, modelTier: "primary", apiAttempt: 1 },
  {
    stage: "merge-summary",
    generationId: id,
    orderedResultManifestId: id,
    modelTier: "fallback",
    apiAttempt: 1,
  },
  { stage: "persist", generationId: id, finalResultId: id, feedJobId: id },
  {
    stage: "job-finalize",
    countVersion: 1,
    counts: { fetched: 2, succeeded: 1, failed: 1, cancelled: 0 },
  },
];

describe("batch contracts", () => {
  it.each(stages)("accepts $stage and rejects extra fields and incompatible versions", (stage) => {
    const value = { ...common, ...stage };
    expect(stageRequestSchema.safeParse(value).success).toBe(true);
    for (const changed of [
      { arbitraryModel: "any" },
      { apiVersion: "v2" },
      { environment: "preview" },
      { operationKey: "bad" },
      { deadlineAt: "tomorrow" },
      { jobId: "not-an-id" },
    ]) {
      expect(stageRequestSchema.safeParse({ ...value, ...changed }).success).toBe(false);
    }
  });
  it("rejects cross-stage references, invalid attempts, and unbounded discovery", () => {
    expect(stageRequestSchema.safeParse({ ...common, ...stages[0], chunkId: id }).success).toBe(
      false,
    );
    expect(stageRequestSchema.safeParse({ ...common, ...stages[0], maxItems: 0 }).success).toBe(
      false,
    );
    expect(stageRequestSchema.safeParse({ ...common, ...stages[0], maxItems: 101 }).success).toBe(
      false,
    );
    expect(stageRequestSchema.safeParse({ ...common, ...stages[2], apiAttempt: 0 }).success).toBe(
      false,
    );
    expect(
      stageRequestSchema.safeParse({ ...common, ...stages[2], modelTier: "arbitrary" }).success,
    ).toBe(false);
  });
  it("bounds manifest pages and preserves explicit environment and snapshot", () => {
    const query = { apiVersion: "v1", environment: "staging", manifestId: id, limit: 50 };
    expect(manifestQuerySchema.parse(query)).toEqual(query);
    expect(manifestQuerySchema.safeParse({ ...query, limit: 51 }).success).toBe(false);
    expect(manifestQuerySchema.safeParse({ ...query, cursor: "x".repeat(2049) }).success).toBe(
      false,
    );
  });
  it("requires status-specific fields and rejects payload leaks", () => {
    expect(operationStatusSchema.parse({ status: "uncertain" })).toEqual({ status: "uncertain" });
    expect(operationStatusSchema.safeParse({ status: "succeeded" }).success).toBe(false);
    expect(
      operationStatusSchema.safeParse({ status: "succeeded", resultId: id, prompt: "private" })
        .success,
    ).toBe(false);
    expect(
      stageResponseSchema.safeParse({
        status: "succeeded",
        stage: "extract",
        contentId: id,
        chunkManifestId: id,
        chunkCount: 1,
        inputHash: hash,
      }).success,
    ).toBe(true);
    expect(
      stageResponseSchema.safeParse({
        status: "succeeded",
        stage: "persist",
        articleId: id,
        publication: "alreadyPublished",
      }).success,
    ).toBe(true);
  });
  it("separates gate reservation generations from API attempts", () => {
    const reserve = {
      action: "reserve",
      apiVersion: "v1",
      environment: "staging",
      operationKey: hash,
      apiAttempt: 1,
      model: "configured-model",
      inputTokens: 10,
      outputTokenLimit: 20,
      reservationGeneration: 2,
    };
    expect(gateRequestSchema.safeParse(reserve).success).toBe(true);
    expect(gateRequestSchema.safeParse({ ...reserve, inputTokens: -1 }).success).toBe(false);
    expect(gateRequestSchema.safeParse({ ...reserve, permitId: id }).success).toBe(false);
  });
});

const keyInput = {
  environment: "staging" as const,
  stage: "summarize-chunk" as const,
  logicalEntityId: id,
  inputHash: hash,
  model: "configured-model",
  promptVersion: "1",
  schemaVersion: "1",
};
describe("batch keys", () => {
  it("is deterministic across property insertion order and changes for every semantic input", async () => {
    const key = await operationKey(keyInput);
    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await operationKey({
        schemaVersion: "1",
        promptVersion: "1",
        model: "configured-model",
        inputHash: hash,
        logicalEntityId: id,
        stage: "summarize-chunk",
        environment: "staging",
      }),
    ).toBe(key);
    for (const field of ["logicalEntityId", "model", "promptVersion", "schemaVersion"] as const) {
      expect(await operationKey({ ...keyInput, [field]: "different" })).not.toBe(key);
    }
    expect(await operationKey({ ...keyInput, environment: "production" })).not.toBe(key);
    expect(await operationKey({ ...keyInput, inputHash: "b".repeat(64) })).not.toBe(key);
    expect(await operationKey({ ...keyInput, stage: "merge-summary" })).not.toBe(key);
  });
  it("does not collide on delimiter-bearing values", async () => {
    expect(await operationKey({ ...keyInput, model: "a:b", promptVersion: "c" })).not.toBe(
      await operationKey({ ...keyInput, model: "a", promptVersion: "b:c" }),
    );
  });
  it("uses stable bounded workflow IDs scoped by environment and resume generation", async () => {
    const first = await workflowInstanceId("staging", id, 0);
    expect(first.length).toBeLessThanOrEqual(100);
    expect(await workflowInstanceId("staging", id, 0)).toBe(first);
    expect(await workflowInstanceId("production", id, 0)).not.toBe(first);
    expect(await workflowInstanceId("staging", id, 1)).not.toBe(first);
    await expect(workflowInstanceId("staging", id, -1)).rejects.toThrow();
  });
});

describe("work transitions", () => {
  const states = ["pending", "running", "waiting", "succeeded", "failed", "cancelled"] as const;
  const legal = new Set([
    "pending:running",
    "pending:cancelled",
    "running:waiting",
    "running:succeeded",
    "running:failed",
    "running:cancelled",
    "waiting:pending",
    "waiting:cancelled",
  ]);
  it("checks the complete transition matrix, including terminal protection", () => {
    for (const from of states)
      for (const to of states) expect(canTransitionWork(from, to)).toBe(legal.has(`${from}:${to}`));
  });
  it("fences owners independently of state version and refuses stale or expired commits", () => {
    const current = {
      state: "running" as const,
      stateVersion: 2,
      leaseEpoch: 3,
      leaseOwner: "owner",
      leaseUntil: 1000,
    };
    const claim = { stateVersion: 2, leaseEpoch: 3, leaseOwner: "owner", now: 999 };
    expect(transitionWork(current, "succeeded", claim)).toEqual({
      ...current,
      state: "succeeded",
      stateVersion: 3,
      leaseOwner: null,
      leaseUntil: null,
    });
    for (const change of [
      { stateVersion: 1 },
      { leaseEpoch: 2 },
      { leaseOwner: "old" },
      { now: 1000 },
    ])
      expect(() => transitionWork(current, "succeeded", { ...claim, ...change })).toThrow();
  });
  it("aggregates waiting, partial, fatal and cancelled without counting retries as articles", () => {
    expect(aggregateJobStatus(["succeeded", "failed"])).toBe("partial_failed");
    expect(aggregateJobStatus(["failed"])).toBe("failed");
    expect(aggregateJobStatus(["waiting", "succeeded"])).toBe("waiting");
    expect(aggregateJobStatus(["pending", "waiting"])).toBe("running");
    expect(aggregateJobStatus(["cancelled"])).toBe("cancelled");
    expect(aggregateJobStatus([])).toBe("succeeded");
    expect(aggregateJobStatus(["succeeded"], true)).toBe("failed");
  });
});

describe("retry policy", () => {
  it.each([400, 401, 403, 404, 409, 422])("never retries HTTP %i", (status) =>
    expect(classifyFailure({ kind: "http", status })).toBe("terminal"),
  );
  it("forces status lookup before retry and never repeats an uncertain Gemini send", () => {
    expect(
      retryDecision({
        failure: "transient",
        retries: 0,
        now: 0,
        deadlineAt: 100000,
        operationStatus: "unknown",
        jitter: 0,
      }),
    ).toEqual({ action: "lookup" });
    expect(
      retryDecision({
        failure: "uncertain",
        retries: 0,
        now: 0,
        deadlineAt: 100000,
        operationStatus: "not_found",
        jitter: 0,
      }),
    ).toEqual({ action: "uncertain" });
    expect(
      retryDecision({
        failure: "transient",
        retries: 0,
        now: 0,
        deadlineAt: 100000,
        operationStatus: "succeeded",
        jitter: 0,
      }),
    ).toEqual({ action: "reuse" });
  });
  it("rejects invalid clock and retry inputs instead of bypassing deadlines", () => {
    const input = {
      failure: "transient" as const,
      retries: 0,
      now: 0,
      deadlineAt: 100000,
      operationStatus: "not_found" as const,
      jitter: 0,
    };
    for (const changed of [
      { now: NaN },
      { deadlineAt: Infinity },
      { jitter: NaN },
      { retries: -1 },
      { retries: 0.5 },
    ]) {
      expect(() => retryDecision({ ...input, ...changed })).toThrow("INVALID_RETRY_INPUT");
    }
  });
  it("caps retries and enforces deadline at equality with injected jitter", () => {
    const input = {
      failure: "transient" as const,
      retries: 0,
      now: 0,
      deadlineAt: 100000,
      operationStatus: "not_found" as const,
      jitter: 0.5,
    };
    expect(retryDecision(input)).toEqual({ action: "retry", nextEligibleAt: 5500 });
    expect(retryDecision({ ...input, retries: 1 })).toEqual({
      action: "retry",
      nextEligibleAt: 30500,
    });
    expect(retryDecision({ ...input, retries: 2 })).toEqual({ action: "stop" });
    expect(retryDecision({ ...input, deadlineAt: 5500 })).toEqual({ action: "stop" });
    expect(retryDecision({ ...input, failure: "quota", retries: 2 })).toEqual({ action: "wait" });
  });
});
