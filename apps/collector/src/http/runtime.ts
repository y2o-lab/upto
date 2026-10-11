import type { DbClient } from "@upto/db";

import { MergeInputRepository, NonceRepository } from "@upto/db/collector";
import {
  operationKey,
  stageRequestSchema,
  type BatchEnvironment,
  type PrepareRequest,
} from "@upto/domain/batch";

import type { FeedTarget } from "../feeds.js";
import type { BatchObserver } from "../observability.js";
import type { GenerationDependencies } from "../stages/generation-sender.js";

import { createDiscoveryStage } from "../stages/discovery.js";
import { createExtractStage } from "../stages/extract.js";
import { createGeminiGenerationAdapter } from "../stages/gemini-adapter.js";
import { createJobFinalizeStage } from "../stages/job-finalize.js";
import { createMergeSummaryStage } from "../stages/merge-summary.js";
import { createPersistStage } from "../stages/persist.js";
import { createSummarizeChunkStage } from "../stages/summarize-chunk.js";
import { createGateClient } from "./gate-client.js";
import { createCollectorHandler, type CollectorHttpServices } from "./handler.js";
import { createRepositoryHttpServices } from "./repositories.js";
export type NodeRuntimeConfig = {
  environment: BatchEnvironment;
  executorVersion: string;
  configVersion: string;
  promptVersion: string;
  schemaVersion: string;
  countVersion: string;
  chunkerVersion: string;
  primaryModel: string;
  fallbackModel: string;
  maxOutputTokens: number;
  chunkChars: number;
  keys: ReadonlyMap<string, Uint8Array>;
  cursorKey: Uint8Array;
  geminiApiKey: string;
  gateOrigin: string;
  gateKeyId: string;
  gateKey: Uint8Array;
};
export function createNodeRuntime(options: {
  db: DbClient;
  config: NodeRuntimeConfig;
  feeds: ReadonlyMap<string, FeedTarget>;
  dependencies?: { fetcher?: typeof fetch; generation?: GenerationDependencies };
  observer?: BatchObserver;
  logger?: (event: { errorCode: string; requestId: string }) => void;
}) {
  const config = {
    ...options.config,
    cursorKey: new Uint8Array(options.config.cursorKey),
    gateKey: new Uint8Array(options.config.gateKey),
    keys: new Map([...options.config.keys].map(([id, key]) => [id, new Uint8Array(key)])),
  };
  const gate = createGateClient({
    origin: config.gateOrigin,
    environment: config.environment,
    executorVersion: config.executorVersion,
    keyId: config.gateKeyId,
    key: config.gateKey,
  });
  const gemini = createGeminiGenerationAdapter({ apiKey: config.geminiApiKey });
  const generation = options.dependencies?.generation ?? { ...gemini, gate };
  const common = {
    db: options.db,
    cursorKey: config.cursorKey,
    configVersion: config.configVersion,
    executorVersion: config.executorVersion,
    promptVersion: config.promptVersion,
    schemaVersion: config.schemaVersion,
  };
  const summary = {
    ...common,
    primaryModel: config.primaryModel,
    fallbackModel: config.fallbackModel,
    maxOutputTokens: config.maxOutputTokens,
    countVersion: config.countVersion,
    dependencies: { ...generation, ...(options.observer ? { observer: options.observer } : {}) },
  };
  const stages = {
    discovery: createDiscoveryStage({
      ...common,
      feeds: options.feeds,
      ...(options.dependencies?.fetcher ? { fetcher: options.dependencies.fetcher } : {}),
    }),
    extract: createExtractStage({
      db: options.db,
      cursorKey: config.cursorKey,
      chunkChars: config.chunkChars,
      chunkerVersion: config.chunkerVersion,
      ...(options.dependencies?.fetcher ? { fetcher: options.dependencies.fetcher } : {}),
    }),
    "summarize-chunk": createSummarizeChunkStage(summary),
    "merge-summary": createMergeSummaryStage(summary),
    persist: createPersistStage(options.db),
    "job-finalize": createJobFinalizeStage(options.db),
  };
  const services = createRepositoryHttpServices({
    db: options.db,
    cursorKey: config.cursorKey,
    resolve: (request, context) => {
      context.assertTimeLeft();
      return stages[request.stage].resolve(request);
    },
    execute: (request, context) => stages[request.stage].execute(request, context),
  });
  const merge = new MergeInputRepository(options.db, config.cursorKey, [
    config.primaryModel,
    config.fallbackModel,
  ]);
  const prepare: NonNullable<CollectorHttpServices["prepare"]> = async (
    input: PrepareRequest,
    context,
  ) => {
    context.assertTimeLeft();
    if (
      input.environment !== config.environment ||
      input.executorVersion !== config.executorVersion ||
      input.configVersion !== config.configVersion
    )
      throw new Error("GENERATION_VERSION_CONFLICT");
    let manifestId = input.stage === "merge-summary" ? input.orderedResultManifestId : undefined;
    if (input.stage === "merge-summary" && !manifestId) {
      manifestId = (
        await merge.createOrdered({
          environment: input.environment,
          generationId: input.generationId,
          jobId: input.jobId,
          configVersion: input.configVersion,
          executorVersion: input.executorVersion,
          promptVersion: config.promptVersion,
          schemaVersion: config.schemaVersion,
        })
      ).manifestId;
    }
    const request = stageRequestSchema.parse({
      ...input,
      operationKey: "0".repeat(64),
      ...(manifestId ? { orderedResultManifestId: manifestId } : {}),
    });
    const resolved = await stages[request.stage].resolve(request);
    context.assertTimeLeft();
    return {
      apiVersion: "v1",
      stage: request.stage,
      operationKey: await operationKey(resolved.identity),
      inputHash: resolved.identity.inputHash,
      ...("generationId" in request ? { generationId: request.generationId } : {}),
      ...(manifestId ? { orderedResultManifestId: manifestId } : {}),
    };
  };
  services.prepare = prepare;
  const nonces = new NonceRepository(options.db);
  const handler = createCollectorHandler({
    environment: config.environment,
    executorVersions: [config.executorVersion],
    configVersions: [config.configVersion],
    keys: config.keys,
    consumeNonce: (input) => nonces.consume(input),
    services,
    ...(options.observer ? { observer: options.observer } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  return { handler };
}
