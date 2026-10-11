import { z } from "zod";

export const API_VERSION = "v1" as const;
export const MAX_CONTROL_REQUEST_BYTES = 16 * 1024;
export const MAX_CONTROL_RESPONSE_BYTES = 32 * 1024;
export const MAX_MANIFEST_PAGE_SIZE = 50;
export const environmentSchema = z.enum(["staging", "production"]);
export const referenceIdSchema = z.uuid();
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.string().min(1).max(128);
const date = z.iso.datetime({ offset: true });
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const stageSchema = z.enum([
  "discovery",
  "extract",
  "summarize-chunk",
  "merge-summary",
  "persist",
  "job-finalize",
]);
const base = {
  apiVersion: z.literal(API_VERSION),
  environment: environmentSchema,
  jobId: referenceIdSchema,
  workId: referenceIdSchema,
  operationKey: hashSchema,
  executorVersion: version,
  configVersion: version,
  deadlineAt: date,
};
const generation = { generationId: referenceIdSchema };
const generationAttempt = {
  ...generation,
  modelTier: z.enum(["primary", "fallback"]),
  apiAttempt: z.number().int().min(1).max(3),
};
const counts = z
  .strictObject({
    fetched: count.max(2147483647),
    succeeded: count.max(2147483647),
    failed: count.max(2147483647),
    cancelled: count.max(2147483647),
  })
  .refine((value) => value.succeeded + value.failed + value.cancelled <= value.fetched);
export const stageRequestSchema = z.discriminatedUnion("stage", [
  z.strictObject({
    ...base,
    stage: z.literal("discovery"),
    feedId: version,
    scheduledAt: date,
    maxItems: z.number().int().min(1).max(100),
  }),
  z.strictObject({
    ...base,
    stage: z.literal("extract"),
    ...generation,
    candidateId: referenceIdSchema,
  }),
  z.strictObject({
    ...base,
    stage: z.literal("summarize-chunk"),
    ...generationAttempt,
    chunkId: referenceIdSchema,
  }),
  z.strictObject({
    ...base,
    stage: z.literal("merge-summary"),
    ...generationAttempt,
    orderedResultManifestId: referenceIdSchema,
  }),
  z.strictObject({
    ...base,
    stage: z.literal("persist"),
    ...generation,
    finalResultId: referenceIdSchema,
    feedJobId: referenceIdSchema,
  }),
  z.strictObject({
    ...base,
    stage: z.literal("job-finalize"),
    countVersion: z.number().int().positive().max(2147483647),
    counts,
    errorCode: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,63}$/)
      .optional(),
  }),
]);
const queryBase = { apiVersion: z.literal(API_VERSION), environment: environmentSchema };
export const manifestQuerySchema = z.strictObject({
  ...queryBase,
  manifestId: referenceIdSchema,
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.number().int().min(1).max(MAX_MANIFEST_PAGE_SIZE),
});
export const operationStatusQuerySchema = z.strictObject({
  ...queryBase,
  operationKey: hashSchema,
});
export const errorCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const running = z.strictObject({ status: z.literal("running"), leaseUntil: date });
const waiting = z.strictObject({
  status: z.literal("waiting"),
  reason: errorCodeSchema,
  nextEligibleAt: date,
});
const failed = z.strictObject({
  status: z.literal("failed"),
  errorCode: errorCodeSchema,
  retryable: z.boolean(),
});
export const operationStatusSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("not_found") }),
  running,
  waiting,
  z.strictObject({ status: z.literal("succeeded"), resultId: referenceIdSchema }),
  failed,
  z.strictObject({ status: z.literal("uncertain") }),
]);
const success = { status: z.literal("succeeded") };
export const stageSuccessSchema = z.discriminatedUnion("stage", [
  z.strictObject({
    ...success,
    stage: z.literal("discovery"),
    discoveryId: referenceIdSchema,
    manifestId: referenceIdSchema,
    candidateCount: count,
  }),
  z.strictObject({
    ...success,
    stage: z.literal("extract"),
    contentId: referenceIdSchema,
    chunkManifestId: referenceIdSchema,
    chunkCount: z.number().int().positive(),
    inputHash: hashSchema,
  }),
  z.strictObject({
    ...success,
    stage: z.literal("summarize-chunk"),
    resultId: referenceIdSchema,
    effectiveModel: version,
    usageId: referenceIdSchema,
  }),
  z.strictObject({
    ...success,
    stage: z.literal("merge-summary"),
    finalResultId: referenceIdSchema,
    schemaVersion: version,
  }),
  z.strictObject({
    ...success,
    stage: z.literal("persist"),
    articleId: referenceIdSchema,
    publication: z.enum(["published", "alreadyPublished"]),
  }),
  z.strictObject({
    ...success,
    stage: z.literal("job-finalize"),
    crawlJobId: referenceIdSchema,
    countVersion: z.number().int().positive(),
  }),
]);
export const stageResponseSchema = z.union([stageSuccessSchema, running, waiting, failed]);
export const manifestResponseSchema = z.strictObject({
  manifestId: referenceIdSchema,
  entries: z
    .array(
      z.union([
        z.strictObject({
          candidateId: referenceIdSchema,
          disposition: z.enum(["process", "alreadyPublished", "failed"]),
          errorCode: errorCodeSchema.optional(),
          generationId: referenceIdSchema.optional(),
          feedJobId: referenceIdSchema.optional(),
        }),
        z.strictObject({ chunkId: referenceIdSchema, index: count, inputHash: hashSchema }),
        z.strictObject({ resultId: referenceIdSchema, index: count, inputHash: hashSchema }),
      ]),
    )
    .max(MAX_MANIFEST_PAGE_SIZE),
  nextCursor: z.string().min(1).max(2048).nullable(),
});
const gateBase = {
  ...queryBase,
  operationKey: hashSchema,
  apiAttempt: z.number().int().min(1).max(3),
};
export const gateRequestSchema = z.discriminatedUnion("action", [
  z.strictObject({
    ...gateBase,
    action: z.literal("reserve"),
    model: version,
    inputTokens: count,
    outputTokenLimit: count,
    reservationGeneration: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({ ...gateBase, action: z.literal("consume"), permitId: referenceIdSchema }),
  z.strictObject({
    ...gateBase,
    action: z.literal("report"),
    permitId: referenceIdSchema,
    outcome: z.enum(["succeeded", "failed", "uncertain", "rate_limited"]),
    inputTokens: count,
    outputTokens: count,
  }),
]);
export type BatchEnvironment = z.infer<typeof environmentSchema>;
export type BatchStage = z.infer<typeof stageSchema>;
export type StageRequest = z.infer<typeof stageRequestSchema>;
export type StageResponse = z.infer<typeof stageResponseSchema>;
export type OperationStatus = z.infer<typeof operationStatusSchema>;

export const tokenUsageSchema = z.strictObject({ inputTokens: count, outputTokens: count });
