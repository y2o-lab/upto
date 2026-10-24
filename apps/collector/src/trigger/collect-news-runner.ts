import type { RunCollectorResult } from "../run-collector.js";

import {
  CollectorExecutionError,
  executeCollector,
  type ExecuteCollectorInput,
} from "../execute-collector.js";
import {
  collectorIssueSchema,
  describeCollectorError,
  serializeFailureReport,
  type CollectorReport,
} from "../notifications/collector-report.js";

export type TriggerTaskLogger = {
  error(message: string, attributes?: Record<string, unknown>): void;
  info(message: string, attributes?: Record<string, unknown>): void;
  warn(message: string, attributes?: Record<string, unknown>): void;
};

export type ExecuteCollectNewsTaskInput = {
  attemptNumber: number;
  execute?: (input?: ExecuteCollectorInput) => Promise<RunCollectorResult>;
  logger: TriggerTaskLogger;
  now?: () => number;
  runId: string;
};

export class CollectorTaskError extends Error {
  constructor(report?: CollectorReport) {
    super(report ? serializeFailureReport(report) : "Collector task failed.");
    this.name = "CollectorTaskError";
  }
}

export type CollectNewsTaskResult = RunCollectorResult & { notificationReport: CollectorReport };

export async function executeCollectNewsTask(
  input: ExecuteCollectNewsTaskInput,
): Promise<CollectNewsTaskResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const report: CollectorReport = {
    durationMs: 0,
    issues: [],
    metricsFailedCount: 0,
    skippedDuplicateCount: 0,
  };
  const context = {
    attemptNumber: input.attemptNumber,
    runId: input.runId,
  };

  input.logger.info("Collector run started", context);

  try {
    const result = await (input.execute ?? executeCollector)({
      dependencies: {
        logger: (event) => {
          if (event.status === "article_skipped_duplicate") report.skippedDuplicateCount++;
          if (event.status === "article_duplicate_metrics_update_failed")
            report.metricsFailedCount++;
          if (
            ["article_failed", "feed_failed", "article_duplicate_metrics_update_failed"].includes(
              String(event.status),
            ) &&
            report.issues.length < 10
          ) {
            const issue = collectorIssueSchema.safeParse(event.errorDetails);
            report.issues.push({
              ...(issue.success
                ? issue.data
                : { stage: "execution" as const, kind: "unknown" as const }),
              ...(typeof event.feed === "string" ? { feed: event.feed.slice(0, 80) } : {}),
            });
          }
          logCollectorEvent(input.logger, context, event);
        },
      },
    });
    const attributes = {
      ...result,
      ...context,
      durationMs: Math.max(0, now() - startedAt),
    };

    if (result.failedCount > 0 || report.metricsFailedCount > 0) {
      input.logger.warn("Collector run completed with errors", attributes);
    } else {
      input.logger.info("Collector run completed", attributes);
    }

    report.durationMs = attributes.durationMs;
    return { ...result, notificationReport: report };
  } catch (error) {
    report.durationMs = Math.max(0, now() - startedAt);
    if (report.issues.length === 10) report.issues.pop();
    report.issues.push(describeCollectorError(error));
    input.logger.error("Collector run failed", {
      ...context,
      ...safeErrorCode(error),
      errorType: safeErrorType(error),
    });
    throw new CollectorTaskError(report);
  }
}

function logCollectorEvent(
  logger: TriggerTaskLogger,
  context: { attemptNumber: number; runId: string },
  event: Record<string, unknown>,
): void {
  const attributes = {
    ...sanitizeCollectorEvent(event),
    ...context,
  };
  const status = typeof event.status === "string" ? event.status : "";

  if (status.includes("failed") || status.includes("errors")) {
    logger.warn("Collector event", attributes);
    return;
  }

  logger.info("Collector event", attributes);
}

function sanitizeCollectorEvent(event: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  const scalarKeys = [
    "articleCount",
    "dryRun",
    "failedCount",
    "failedFeedCount",
    "feed",
    "feedCount",
    "fetchedCount",
    "jobId",
    "status",
    "successfulFeedCount",
  ] as const;

  for (const key of scalarKeys) {
    const value = event[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      sanitized[key] = value;
    }
  }

  if (Array.isArray(event.feeds)) {
    sanitized.feeds = event.feeds.flatMap((feed) => {
      if (!isRecord(feed)) {
        return [];
      }
      const name = typeof feed.name === "string" ? feed.name : undefined;
      const kind = typeof feed.kind === "string" ? feed.kind : undefined;
      return name && kind ? [{ kind, name }] : [];
    });
  }

  const details = collectorIssueSchema.safeParse(event.errorDetails);
  if (details.success) sanitized.errorDetails = details.data;

  return sanitized;
}

function safeErrorType(error: unknown): string {
  if (error instanceof CollectorExecutionError) {
    return "CollectorExecutionError";
  }
  if (error instanceof Error) {
    return "Error";
  }
  return "UnknownError";
}

function safeErrorCode(error: unknown): { errorCode?: string } {
  if (!isRecord(error) || typeof error.code !== "string") {
    return {};
  }

  return /^[A-Z0-9_]{2,32}$/.test(error.code) ? { errorCode: error.code } : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
