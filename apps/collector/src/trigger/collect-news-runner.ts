import type { RunCollectorResult } from "../run-collector.js";

import {
  CollectorExecutionError,
  executeCollector,
  type ExecuteCollectorInput,
} from "../execute-collector.js";

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
  constructor() {
    super("Collector task failed.");
    this.name = "CollectorTaskError";
  }
}

export async function executeCollectNewsTask(
  input: ExecuteCollectNewsTaskInput,
): Promise<RunCollectorResult> {
  const now = input.now ?? Date.now;
  const startedAt = now();
  const context = {
    attemptNumber: input.attemptNumber,
    runId: input.runId,
  };

  input.logger.info("Collector run started", context);

  try {
    const result = await (input.execute ?? executeCollector)({
      dependencies: {
        logger: (event) => logCollectorEvent(input.logger, context, event),
      },
    });
    const attributes = {
      ...result,
      ...context,
      durationMs: Math.max(0, now() - startedAt),
    };

    if (result.failedCount > 0) {
      input.logger.warn("Collector run completed with errors", attributes);
    } else {
      input.logger.info("Collector run completed", attributes);
    }

    return result;
  } catch (error) {
    input.logger.error("Collector run failed", {
      ...context,
      ...safeErrorCode(error),
      errorType: safeErrorType(error),
    });
    throw new CollectorTaskError();
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
