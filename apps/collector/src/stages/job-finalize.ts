import type { DbClient } from "@upto/db";

import { FinalizationRepository, OperationRepository, ResultRepository } from "@upto/db/collector";
import { operationKey, type StageRequest } from "@upto/domain/batch";

import type { CollectorHttpServices } from "../http/handler.js";
import type { ResolvedOperation } from "../http/repositories.js";

export function createJobFinalizeStage(db: DbClient) {
  const repository = new FinalizationRepository(db);
  const operations = new OperationRepository(db);
  const results = new ResultRepository(db);
  function input(request: StageRequest) {
    if (request.stage !== "job-finalize") throw new Error("FINALIZATION_REFERENCE_MISMATCH");
    return {
      environment: request.environment,
      jobId: request.jobId,
      countVersion: request.countVersion,
      counts: request.counts,
      errorCode: request.errorCode ?? null,
    };
  }
  async function resolve(request: StageRequest): Promise<ResolvedOperation> {
    const resolved = await repository.describe(input(request));
    if (
      resolved.configVersion !== request.configVersion ||
      resolved.executorVersion !== request.executorVersion
    )
      throw new Error("GENERATION_VERSION_CONFLICT");
    return { identity: resolved.identity };
  }
  const execute: CollectorHttpServices["execute"] = async (request, context) => {
    context.assertTimeLeft();
    const resolved = await resolve(request);
    if ((await operationKey(resolved.identity)) !== request.operationKey)
      throw new Error("OPERATION_INPUT_CONFLICT");
    const claim = await operations.claim({
      ...resolved.identity,
      operationKey: request.operationKey,
      owner: context.auth.requestId,
      leaseMs: 360000,
    });
    if (claim.status === "claimed") return repository.finalize(claim.fence, input(request));
    if (claim.status === "succeeded") {
      const result = await results.read(request.environment, claim.resultId);
      if (result?.output.kind !== "stage" || result.output.response.stage !== "job-finalize")
        throw new Error("FINALIZATION_REFERENCE_MISMATCH");
      return result.output.response;
    }
    if (claim.status === "uncertain" || claim.status === "not_found")
      throw new Error("FINALIZATION_REFERENCE_MISMATCH");
    return claim;
  };
  return { resolve, execute };
}
