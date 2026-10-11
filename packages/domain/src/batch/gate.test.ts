import { expect, it } from "vitest";

import { gateReserveResponseSchema, gateConsumeResponseSchema } from "./gate.js";
it("validates gate permits and rejects extra fields or invalid waiting reasons", () => {
  const permitId = crypto.randomUUID();
  expect(
    gateReserveResponseSchema.parse({
      status: "reserved",
      permitId,
      expiresAt: "2026-10-11T00:00:05Z",
      quotaVersion: "1",
    }).status,
  ).toBe("reserved");
  expect(
    gateConsumeResponseSchema.safeParse({ status: "consumed", permitId, reusable: true }).success,
  ).toBe(false);
  expect(
    gateReserveResponseSchema.safeParse({
      status: "waiting",
      reason: "private token",
      nextEligibleAt: "2026-10-11T00:00:05Z",
    }).success,
  ).toBe(false);
});
