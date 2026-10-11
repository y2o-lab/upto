import type { DbClient } from "@upto/db";

import { ManifestRepository, OperationRepository, ResultRepository } from "@upto/db/collector";
import { operationKey, type OperationKeyInput, type StageRequest } from "@upto/domain/batch";

import type { CollectorHttpServices, HttpExecutionContext } from "./handler.js";

export type ResolvedOperation = { identity: OperationKeyInput; generationId?: string };
export function createRepositoryHttpServices(options: {
  db: DbClient;
  cursorKey: Uint8Array;
  resolve(request: StageRequest, context: HttpExecutionContext): Promise<ResolvedOperation>;
  execute: CollectorHttpServices["execute"];
}): CollectorHttpServices {
  const operations = new OperationRepository(options.db);
  const manifests = new ManifestRepository(options.db, options.cursorKey);
  const results = new ResultRepository(options.db);
  return {
    execute: options.execute,
    manifests: (query, context) => {
      context.assertTimeLeft();
      return manifests.page(query);
    },
    operationStatus: (query, context) => {
      context.assertTimeLeft();
      return operations.status(query.environment, query.operationKey);
    },
    async replay(request, context) {
      context.assertTimeLeft();
      // Resolving extract/merge can create snapshots. An expired fresh request
      // may only look up committed success; it must not bind new inputs.
      if (Date.parse(request.deadlineAt) <= Date.now()) {
        const cached = await operations.status(request.environment, request.operationKey);
        if (cached.status !== "succeeded") return null;
      }
      const resolved = await options.resolve(request, context);
      if (
        resolved.identity.environment !== request.environment ||
        resolved.identity.stage !== request.stage ||
        (await operationKey(resolved.identity)) !== request.operationKey
      )
        throw new Error("OPERATION_INPUT_CONFLICT");
      const status = await operations.status(request.environment, request.operationKey);
      if (status.status === "not_found") return null;
      if (status.status === "running")
        return Date.parse(status.leaseUntil) > Date.now() ? status : null;
      if (status.status === "waiting")
        return Date.parse(status.nextEligibleAt) > Date.now() ? status : null;
      if (status.status === "failed") return status;
      if (status.status === "uncertain")
        return { status: "failed", errorCode: "GENERATION_OUTCOME_UNKNOWN", retryable: false };
      const result = await results.read(
        request.environment,
        status.resultId,
        resolved.generationId,
      );
      if (
        !result ||
        result.stage !== request.stage ||
        result.inputHash !== resolved.identity.inputHash ||
        result.promptVersion !== resolved.identity.promptVersion ||
        result.schemaVersion !== resolved.identity.schemaVersion ||
        result.effectiveModel !== resolved.identity.model
      )
        throw new Error("RESULT_REFERENCE_MISMATCH");
      if (result.output.kind === "stage") {
        if (result.output.response.stage !== request.stage)
          throw new Error("RESULT_REFERENCE_MISMATCH");
        return result.output.response;
      }
      if (request.stage === "summarize-chunk")
        return {
          status: "succeeded",
          stage: request.stage,
          resultId: result.id,
          effectiveModel: result.effectiveModel,
          usageId: result.id,
        };
      if (request.stage === "merge-summary" && result.output.kind === "summary")
        return {
          status: "succeeded",
          stage: request.stage,
          finalResultId: result.id,
          schemaVersion: result.schemaVersion,
        };
      throw new Error("RESULT_REFERENCE_MISMATCH");
    },
  };
}
