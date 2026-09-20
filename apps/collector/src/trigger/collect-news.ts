import { logger, schedules } from "@trigger.dev/sdk";

import { executeCollectNewsTask } from "./collect-news-runner.js";

export const collectNewsDefinition: Parameters<typeof schedules.task>[0] = {
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
  run: async (_payload, { ctx }) =>
    executeCollectNewsTask({
      attemptNumber: ctx.attempt.number,
      logger,
      runId: ctx.run.id,
    }),
};

export const collectNews = schedules.task(collectNewsDefinition);
