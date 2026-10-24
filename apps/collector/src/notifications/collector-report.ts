import { z } from "zod";

const stageSchema = z.enum([
  "execution",
  "feed_job",
  "feed_fetch",
  "article_lookup",
  "extract",
  "summarize",
  "persist",
  "metrics_update",
]);
const kindSchema = z.enum([
  "rate_limit",
  "unauthorized",
  "upstream",
  "http",
  "database",
  "network",
  "timeout",
  "validation",
  "configuration",
  "all_feeds_failed",
  "unknown",
]);
export const collectorIssueSchema = z.object({
  stage: stageSchema,
  kind: kindSchema,
  httpStatus: z.number().int().min(400).max(599).optional(),
  feed: z.string().max(80).optional(),
});
export type CollectorIssue = z.infer<typeof collectorIssueSchema>;
export const collectorReportSchema = z.object({
  durationMs: z.number().nonnegative(),
  issues: z.array(collectorIssueSchema).max(10),
  metricsFailedCount: z.number().int().nonnegative(),
  skippedDuplicateCount: z.number().int().nonnegative(),
});
export type CollectorReport = z.infer<typeof collectorReportSchema>;

class CollectorStageError extends Error {
  constructor(
    readonly details: CollectorIssue,
    error: unknown,
  ) {
    super(error instanceof Error ? error.message : "Collector operation failed.");
  }
}

export async function atCollectorStage<T>(
  stage: CollectorIssue["stage"],
  operation: () => Promise<T>,
  feed?: string,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new CollectorStageError(
      { ...describeCollectorError(error), stage, ...(feed ? { feed: feed.slice(0, 80) } : {}) },
      error,
    );
  }
}

export function describeCollectorError(error: unknown): CollectorIssue {
  if (error instanceof CollectorStageError) return error.details;
  const value =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const status = typeof value.status === "number" ? value.status : value.statusCode;
  const httpStatus =
    typeof status === "number" && Number.isInteger(status) && status >= 400 && status <= 599
      ? status
      : undefined;
  let kind: CollectorIssue["kind"] = "unknown";
  if (httpStatus === 429) kind = "rate_limit";
  else if (httpStatus === 401 || httpStatus === 403) kind = "unauthorized";
  else if (httpStatus && httpStatus >= 500) kind = "upstream";
  else if (httpStatus) kind = "http";
  else if (value.name === "ZodError") kind = "validation";
  else if (value.name === "CollectorExecutionError") kind = "all_feeds_failed";
  else if (["TimeoutError", "AbortError"].includes(String(value.name))) kind = "timeout";
  else if (["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN"].includes(String(value.code)))
    kind = "network";
  else if (typeof value.code === "string" && /^(08|28|42|53|57)\w{3}$/.test(value.code))
    kind = "database";
  else if (
    error instanceof Error &&
    /^(DATABASE_URL|GEMINI_API_KEY) is required/.test(error.message)
  )
    kind = "configuration";
  return { stage: "execution", kind, ...(httpStatus ? { httpStatus } : {}) };
}

const failurePrefix = "Collector task failed. ";

// Trigger.dev serializes errors; custom Error properties do not survive that boundary.
// Only this bounded, allowlisted report is carried in the public error message.
export function serializeFailureReport(report: CollectorReport): string {
  return failurePrefix + JSON.stringify(collectorReportSchema.parse(report));
}

export function readFailureReport(error: unknown): CollectorReport | undefined {
  if (
    typeof error !== "object" ||
    error === null ||
    !("message" in error) ||
    typeof error.message !== "string"
  )
    return undefined;
  if (!error.message.startsWith(failurePrefix) || error.message.length > 5000) return undefined;
  try {
    const parsed = collectorReportSchema.safeParse(
      JSON.parse(error.message.slice(failurePrefix.length)),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
