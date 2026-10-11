import { z } from "zod";

import { referenceIdSchema, errorCodeSchema } from "./contracts.js";
const waiting = z.strictObject({
  status: z.literal("waiting"),
  reason: errorCodeSchema,
  nextEligibleAt: z.iso.datetime({ offset: true }),
});
export const gateReserveResponseSchema = z.union([
  waiting,
  z.strictObject({
    status: z.literal("reserved"),
    permitId: referenceIdSchema,
    expiresAt: z.iso.datetime({ offset: true }),
    quotaVersion: z.string().min(1).max(128),
  }),
]);
export const gateConsumeResponseSchema = z.union([
  waiting,
  z.strictObject({ status: z.literal("consumed"), permitId: referenceIdSchema }),
]);
export const gateReportResponseSchema = z.strictObject({ status: z.literal("reported") });
export type GateReserveResponse = z.infer<typeof gateReserveResponseSchema>;
export type GateConsumeResponse = z.infer<typeof gateConsumeResponseSchema>;
