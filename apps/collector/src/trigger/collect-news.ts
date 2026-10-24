import { logger, schedules } from "@trigger.dev/sdk";

import { describeCollectorError, readFailureReport } from "../notifications/collector-report.js";
import { notifyCollector } from "../notifications/slack.js";
import { executeCollectNewsTask, type CollectNewsTaskResult } from "./collect-news-runner.js";

export const collectNewsDefinition: Parameters<
  typeof schedules.task<"collect-news", CollectNewsTaskResult, undefined>
>[0] = {
  id: "collect-news",
  machine: "medium-2x",
  maxDuration: 7_200,
  queue: {
    concurrencyLimit: 1,
  },
  retry: {
    factor: 2,
    maxAttempts: 2,
    maxTimeoutInMs: 300_000,
    minTimeoutInMs: 30_000,
    randomize: true,
  },
  onSuccess: async ({ output, ctx }) => {
    await notifyCollector(
      {
        context: {
          attemptNumber: ctx.attempt.number,
          environment: ctx.environment.slug,
          runId: ctx.run.id,
        },
        result: output,
        report: output.notificationReport,
      },
      { logger },
    );
  },
  onFailure: async ({ error, ctx }) => {
    await notifyCollector(
      {
        context: {
          attemptNumber: ctx.attempt.number,
          environment: ctx.environment.slug,
          runId: ctx.run.id,
        },
        report: readFailureReport(error) ?? {
          durationMs: Math.max(0, Date.now() - ctx.attempt.startedAt.getTime()),
          issues: [describeCollectorError(error)],
          metricsFailedCount: 0,
          skippedDuplicateCount: 0,
        },
      },
      { logger },
    );
  },
  run: async (_payload, { ctx }) =>
    executeCollectNewsTask({
      attemptNumber: ctx.attempt.number,
      logger,
      runId: ctx.run.id,
    }),
};

export const collectNews = schedules.task(collectNewsDefinition);
