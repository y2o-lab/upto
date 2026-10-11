import {
  environmentSchema,
  referenceIdSchema,
  operationOutputSchema,
  tokenUsageSchema,
  type BatchEnvironment,
} from "@upto/domain/batch";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";

import type { DbClient } from "../client.js";

import { collectorResults as results, collectorOperations as operations } from "./schema.js";

export class ResultRepository {
  constructor(private readonly db: Pick<DbClient, "select">) {}
  async read(environment: BatchEnvironment, resultId: string, generationId?: string) {
    environmentSchema.parse(environment);
    referenceIdSchema.parse(resultId);
    if (generationId !== undefined) referenceIdSchema.parse(generationId);
    const [row] = await this.db
      .select({ result: results, operation: operations })
      .from(results)
      .innerJoin(
        operations,
        and(
          eq(operations.environment, results.environment),
          eq(operations.operationKey, results.operationKey),
          eq(operations.resultId, results.id),
          eq(operations.status, "succeeded"),
        ),
      )
      .where(
        and(
          eq(results.environment, environment),
          eq(results.id, resultId),
          generationId !== undefined ? eq(results.generationId, generationId) : undefined,
        ),
      );
    if (!row) return null;
    if (
      row.result.effectiveModel !== row.operation.model ||
      row.result.generationId !== row.operation.generationId
    )
      throw new Error("RESULT_REFERENCE_MISMATCH");
    const output = operationOutputSchema.parse(row.result.validatedJson);
    if (createHash("sha256").update(JSON.stringify(output)).digest("hex") !== row.result.outputHash)
      throw new Error("RESULT_INTEGRITY_MISMATCH");
    return {
      id: row.result.id,
      createdAt: row.result.createdAt,
      generationId: row.result.generationId,
      output,
      outputHash: row.result.outputHash,
      usage: tokenUsageSchema.parse(row.result.usage),
      effectiveModel: row.result.effectiveModel,
      operationKey: row.operation.operationKey,
      logicalEntityId: row.operation.logicalEntityId,
      inputHash: row.operation.inputHash,
      promptVersion: row.operation.promptVersion,
      schemaVersion: row.operation.schemaVersion,
      stage: row.operation.stage,
    };
  }
}
