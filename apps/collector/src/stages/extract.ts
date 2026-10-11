import type { DbClient } from "@upto/db";

import {
  ExtractionRepository,
  OperationRepository,
  PayloadRepository,
  ResultRepository,
} from "@upto/db/collector";
import {
  extractionInputSchema,
  extractionSnapshotSchema,
  operationKey,
  type StageRequest,
} from "@upto/domain/batch";

import type { CollectorHttpServices } from "../http/handler.js";

import { extractArticleContent, splitArticleIntoChunks } from "../content.js";
import { createSafeFetcher } from "../http/safe-fetch.js";

export function createExtractStage(options: {
  db: DbClient;
  cursorKey: Uint8Array;
  chunkChars: number;
  chunkerVersion: string;
  fetcher?: typeof fetch;
}) {
  extractionInputSchema.parse({
    url: "https://config.example",
    fallbackText: "",
    fallbackHtml: null,
    chunkChars: options.chunkChars,
    chunkerVersion: options.chunkerVersion,
  });
  const extraction = new ExtractionRepository(options.db);
  const operations = new OperationRepository(options.db);
  const payloads = new PayloadRepository(options.db, options.cursorKey);
  const results = new ResultRepository(options.db);
  const fetcher = options.fetcher ?? createSafeFetcher();
  async function resolve(request: StageRequest) {
    if (request.stage !== "extract") throw new Error("EXTRACTION_REFERENCE_MISMATCH");
    return extraction.describe({
      environment: request.environment,
      generationId: request.generationId,
      candidateId: request.candidateId,
      jobId: request.jobId,
      configVersion: request.configVersion,
      executorVersion: request.executorVersion,
      chunkChars: options.chunkChars,
      chunkerVersion: options.chunkerVersion,
    });
  }
  const execute: CollectorHttpServices["execute"] = async (request, context) => {
    context.assertTimeLeft();
    const value = await resolve(request);
    if ((await operationKey(value.identity)) !== request.operationKey)
      throw new Error("OPERATION_INPUT_CONFLICT");
    context.assertTimeLeft();
    const claim = await operations.claim({
      ...value.identity,
      generationId: value.generationId,
      operationKey: request.operationKey,
      owner: context.auth.requestId,
      leaseMs: 360000,
    });
    if (claim.status === "succeeded") {
      const result = await results.read(request.environment, claim.resultId, value.generationId);
      if (result?.output.kind !== "stage" || result.output.response.stage !== "extract")
        throw new Error("RESULT_REFERENCE_MISMATCH");
      return result.output.response;
    }
    if (claim.status === "uncertain")
      return { status: "failed", errorCode: "GENERATION_OUTCOME_UNKNOWN", retryable: false };
    if (claim.status === "not_found") throw new Error("EXTRACTION_REFERENCE_MISMATCH");
    if (claim.status !== "claimed") return claim;
    const content = await extractArticleContent(
      value.input.url,
      value.input.fallbackText,
      value.input.fallbackHtml,
      (input, init) => fetcher(input, { ...init, signal: context.signal }),
    );
    context.assertTimeLeft();
    if (context.signal.aborted) throw new Error("REQUEST_DEADLINE_EXCEEDED");
    const snapshot = extractionSnapshotSchema.safeParse({
      generationId: value.generationId,
      contentText: content.contentText,
      contentHtml: content.contentHtml,
      extractionStatus: content.status,
      chunkerVersion: value.input.chunkerVersion,
      chunks: splitArticleIntoChunks(content.contentText, value.input.chunkChars),
    });
    if (!snapshot.success) {
      const errorCode =
        content.status === "failed" ? "EXTRACTION_EMPTY" : "EXTRACTION_LIMIT_EXCEEDED";
      await operations.fail(claim.fence, errorCode);
      return { status: "failed", errorCode, retryable: false };
    }
    return payloads.saveExtraction(claim.fence, snapshot.data);
  };
  return { resolve, execute };
}
