import { createDb, closeDb } from "@upto/db";
import { randomUUID } from "node:crypto";

import { defaultFeedTargets } from "../feeds.js";
import { createBatchObserver, readSlackConfig, type BatchObserver } from "../observability.js";
import { readNodeEnvironment, nodeExecutionEnabled } from "./environment.js";
import { createNodeRuntime } from "./runtime.js";
let handler: ((request: Request) => Promise<Response>) | undefined;
const feedIds = ["zenn", "qiita", "hatena-it", "hacker-news", "github-blog"];
function observer(): BatchObserver {
  try {
    const slack = readSlackConfig();
    return createBatchObserver(slack ? { slack } : {});
  } catch {
    const fallback = createBatchObserver();
    return async (record) => {
      await fallback({ event: "runtime_failed", errorCode: "SLACK_CONFIGURATION_INVALID" });
      await fallback(record);
    };
  }
}
let telemetry: BatchObserver | undefined;
async function failure(code: string): Promise<Response> {
  const requestId = randomUUID();
  await (telemetry ??= observer())({
    event: "runtime_failed",
    requestId,
    errorCode: code,
    ...(["staging", "production"].includes(process.env.COLLECTOR_ENVIRONMENT ?? "")
      ? { environment: process.env.COLLECTOR_ENVIRONMENT as "staging" | "production" }
      : {}),
  });
  return Response.json(
    { status: "failed", errorCode: code, retryable: false },
    { status: 503, headers: { "x-upto-request-id": requestId, "cache-control": "no-store" } },
  );
}
export default {
  async fetch(request: Request): Promise<Response> {
    try {
      if (!nodeExecutionEnabled()) return failure("NODE_EXECUTION_DISABLED");
    } catch {
      return failure("NODE_CONFIGURATION_INVALID");
    }
    if (!handler) {
      let db: ReturnType<typeof createDb> | undefined;
      try {
        const env = readNodeEnvironment();
        db = createDb(env.databaseUrl, {
          max: env.databasePoolMax,
          ...(env.databaseSslCa ? { sslCa: env.databaseSslCa } : {}),
        });
        handler = createNodeRuntime({
          db,
          config: env.config,
          feeds: new Map(defaultFeedTargets.map((feed, index) => [feedIds[index]!, feed])),
          observer: (telemetry ??= observer()),
        }).handler;
      } catch {
        if (db) await closeDb(db).catch(() => undefined);
        return failure("NODE_CONFIGURATION_INVALID");
      }
    }
    return handler(request);
  },
};
