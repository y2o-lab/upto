import { z } from "zod";

import { stageRequestSchema, stageSchema, referenceIdSchema, hashSchema } from "./contracts.js";
export const prepareRequestSchema = z.discriminatedUnion("stage", [
  stageRequestSchema.options[0].omit({ operationKey: true }),
  stageRequestSchema.options[1].omit({ operationKey: true }),
  stageRequestSchema.options[2].omit({ operationKey: true }),
  stageRequestSchema.options[3]
    .omit({ operationKey: true })
    .partial({ orderedResultManifestId: true }),
  stageRequestSchema.options[4].omit({ operationKey: true }),
  stageRequestSchema.options[5].omit({ operationKey: true }),
]);
export const prepareResponseSchema = z.strictObject({
  apiVersion: z.literal("v1"),
  stage: stageSchema,
  operationKey: hashSchema,
  inputHash: hashSchema,
  generationId: referenceIdSchema.optional(),
  orderedResultManifestId: referenceIdSchema.optional(),
});
export type PrepareRequest = z.infer<typeof prepareRequestSchema>;
export type PrepareResponse = z.infer<typeof prepareResponseSchema>;
