import { z } from "zod";

import { environmentSchema, referenceIdSchema, errorCodeSchema } from "./contracts.js";
const count = z.number().int().min(0).max(2147483647);
export const finalizationCountsSchema = z
  .strictObject({ fetched: count, succeeded: count, failed: count, cancelled: count })
  .refine((value) => value.succeeded + value.failed + value.cancelled <= value.fetched);
export const finalizationInputSchema = z.strictObject({
  environment: environmentSchema,
  jobId: referenceIdSchema,
  countVersion: z.number().int().min(1).max(2147483647),
  counts: finalizationCountsSchema,
  errorCode: errorCodeSchema.nullable(),
});
export type FinalizationInput = z.infer<typeof finalizationInputSchema>;
