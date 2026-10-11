import { expect, it } from "vitest";

import { prepareRequestSchema, prepareResponseSchema } from "./prepare.js";
const base = {
  apiVersion: "v1",
  environment: "staging",
  jobId: crypto.randomUUID(),
  workId: crypto.randomUUID(),
  executorVersion: "1",
  configVersion: "1",
  deadlineAt: new Date().toISOString(),
};
it("accepts bounded references without a key and permits server creation of a merge manifest", () => {
  expect(
    prepareRequestSchema.safeParse({
      ...base,
      stage: "extract",
      generationId: crypto.randomUUID(),
      candidateId: crypto.randomUUID(),
    }).success,
  ).toBe(true);
  expect(
    prepareRequestSchema.safeParse({
      ...base,
      stage: "merge-summary",
      generationId: crypto.randomUUID(),
      modelTier: "primary",
      apiAttempt: 1,
    }).success,
  ).toBe(true);
  expect(
    prepareRequestSchema.safeParse({
      ...base,
      stage: "extract",
      generationId: crypto.randomUUID(),
      candidateId: crypto.randomUUID(),
      operationKey: "a".repeat(64),
    }).success,
  ).toBe(false);
  expect(
    prepareResponseSchema.safeParse({
      apiVersion: "v1",
      stage: "extract",
      operationKey: "a".repeat(64),
      inputHash: "b".repeat(64),
      prompt: "fixture",
    }).success,
  ).toBe(false);
});
