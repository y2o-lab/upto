import type { DbClient } from "@upto/db";

import { OperationRepository, PublicationRepository, ResultRepository } from "@upto/db/collector";
import { operationKey, type StageRequest } from "@upto/domain/batch";

import type { CollectorHttpServices } from "../http/handler.js";
import type { ResolvedOperation } from "../http/repositories.js";

export function createPersistStage(db: DbClient) {
  const publication = new PublicationRepository(db);
  const operations = new OperationRepository(db);
  const results = new ResultRepository(db);
  async function resolve(request: StageRequest): Promise<ResolvedOperation> {
    if (request.stage !== "persist") throw new Error("PUBLICATION_REFERENCE_MISMATCH");
    const reference = {
      environment: request.environment,
      generationId: request.generationId,
      finalResultId: request.finalResultId,
    };
    const snapshot = await publication.describe(reference);
    if (snapshot.generation.configVersion !== request.configVersion)
      throw new Error("GENERATION_VERSION_CONFLICT");
    await publication.metricsFor({
      ...reference,
      jobId: request.jobId,
      feedJobId: request.feedJobId,
      configVersion: request.configVersion,
      executorVersion: request.executorVersion,
    });
    return { identity: snapshot.identity, generationId: request.generationId };
  }
  const execute: CollectorHttpServices["execute"] = async (request, context) => {
    context.assertTimeLeft();
    if (request.stage !== "persist") throw new Error("PUBLICATION_REFERENCE_MISMATCH");
    const value = await resolve(request);
    if ((await operationKey(value.identity)) !== request.operationKey)
      throw new Error("OPERATION_INPUT_CONFLICT");
    const reference = {
      environment: request.environment,
      generationId: request.generationId,
      finalResultId: request.finalResultId,
    };
    const metrics = await publication.metricsFor({
      ...reference,
      jobId: request.jobId,
      feedJobId: request.feedJobId,
      configVersion: request.configVersion,
      executorVersion: request.executorVersion,
    });
    context.assertTimeLeft();
    const claim = await operations.claim({
      ...value.identity,
      generationId: request.generationId,
      operationKey: request.operationKey,
      owner: context.auth.requestId,
      leaseMs: 360000,
    });
    if (claim.status === "claimed")
      return publication.publish(claim.fence, {
        generationId: request.generationId,
        finalResultId: request.finalResultId,
        metrics,
      });
    if (claim.status === "succeeded") {
      const result = await results.read(request.environment, claim.resultId, request.generationId);
      if (result?.output.kind !== "stage" || result.output.response.stage !== "persist")
        throw new Error("PUBLICATION_REFERENCE_MISMATCH");
      return result.output.response;
    }
    if (claim.status === "uncertain")
      return { status: "failed", errorCode: "GENERATION_OUTCOME_UNKNOWN", retryable: false };
    if (claim.status === "not_found") throw new Error("PUBLICATION_REFERENCE_MISMATCH");
    return claim;
  };
  return { resolve, execute };
}
