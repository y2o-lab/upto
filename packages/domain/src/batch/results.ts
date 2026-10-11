import { z } from "zod";

import { articleSummarySchema } from "../article.js";
import { stageSuccessSchema, tokenUsageSchema } from "./contracts.js";

export const operationOutputSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("chunk"), text: z.string().trim().min(1).max(32768) }),
  z.strictObject({ kind: z.literal("summary"), summary: articleSummarySchema.strict() }),
  z.strictObject({ kind: z.literal("stage"), response: stageSuccessSchema }),
]);
export const resultWriteSchema = z.strictObject({
  output: operationOutputSchema,
  effectiveModel: z.string().max(128),
  usage: tokenUsageSchema,
});
export type OperationOutput = z.infer<typeof operationOutputSchema>;
