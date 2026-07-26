import { readCollectorConfig } from "./config.js";
import { defaultFeedTargets, type FeedTarget } from "./feeds.js";
import {
  runCollector,
  type RunCollectorDependencies,
  type RunCollectorInput,
  type RunCollectorResult,
} from "./run-collector.js";

export type ExecuteCollectorInput = {
  dependencies?: RunCollectorDependencies;
  environment?: NodeJS.ProcessEnv;
  feeds?: FeedTarget[];
  runner?: (input: RunCollectorInput) => Promise<RunCollectorResult>;
};

export class CollectorExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollectorExecutionError";
  }
}

export async function executeCollector(
  input: ExecuteCollectorInput = {},
): Promise<RunCollectorResult> {
  const config = readCollectorConfig(input.environment ?? process.env);
  const runInput: RunCollectorInput = {
    config,
    feeds: input.feeds ?? defaultFeedTargets,
    ...(input.dependencies ? { dependencies: input.dependencies } : {}),
  };
  const result = await (input.runner ?? runCollector)(runInput);

  if (!result.dryRun && result.feedCount > 0 && result.successfulFeedCount === 0) {
    throw new CollectorExecutionError("Collector failed to fetch every configured feed.");
  }

  return result;
}
