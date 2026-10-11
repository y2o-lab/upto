import {
  finalizationInputSchema,
  type FinalizationInput,
  type OperationKeyInput,
} from "@upto/domain/batch";
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

import type { DbClient } from "../client.js";

import { crawlJobs } from "../schema-core.js";
import { OperationRepository, type OperationFence } from "./operations.js";
import {
  collectorDiscoveries as discoveries,
  collectorJobProjections as projections,
  collectorOperations as operations,
} from "./schema.js";

export class FinalizationRepository {
  constructor(private readonly db: DbClient) {}
  async describe(raw: FinalizationInput, db: Pick<DbClient, "select"> = this.db) {
    const input = finalizationInputSchema.parse(raw);
    const rows = await db
      .select()
      .from(discoveries)
      .where(
        and(eq(discoveries.environment, input.environment), eq(discoveries.jobId, input.jobId)),
      );
    const first = rows[0];
    if (
      !first?.crawlJobId ||
      rows.some(
        (row) =>
          row.crawlJobId !== first.crawlJobId ||
          row.configVersion !== first.configVersion ||
          row.executorVersion !== first.executorVersion,
      )
    )
      throw new Error("FINALIZATION_REFERENCE_MISMATCH");
    const inputHash = createHash("sha256")
      .update(
        JSON.stringify([
          input.jobId,
          input.countVersion,
          input.counts,
          input.errorCode,
          first.crawlJobId,
        ]),
      )
      .digest("hex");
    const identity: OperationKeyInput = {
      environment: input.environment,
      stage: "job-finalize",
      logicalEntityId: input.jobId,
      inputHash,
      model: "",
      promptVersion: "projection-v1",
      schemaVersion: "1",
    };
    return {
      identity,
      crawlJobId: first.crawlJobId,
      configVersion: first.configVersion,
      executorVersion: first.executorVersion,
    };
  }
  async finalize(fence: OperationFence, raw: FinalizationInput) {
    const input = finalizationInputSchema.parse(raw);
    if (input.environment !== fence.environment) throw new Error("FINALIZATION_REFERENCE_MISMATCH");
    const resolved = await this.describe(input);
    const response = {
      status: "succeeded" as const,
      stage: "job-finalize" as const,
      crawlJobId: resolved.crawlJobId,
      countVersion: input.countVersion,
    };
    await new OperationRepository(this.db).complete(fence, async (tx) => {
      const current = await this.describe(input, tx);
      const [operation] = await tx
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.environment, fence.environment),
            eq(operations.operationKey, fence.operationKey),
          ),
        );
      if (
        operation?.stage !== "job-finalize" ||
        operation.logicalEntityId !== input.jobId ||
        operation.inputHash !== current.identity.inputHash
      )
        throw new Error("FINALIZATION_REFERENCE_MISMATCH");
      const [job] = await tx
        .select()
        .from(crawlJobs)
        .where(eq(crawlJobs.id, current.crawlJobId))
        .for("update");
      if (!job) throw new Error("FINALIZATION_REFERENCE_MISMATCH");
      const [existing] = await tx
        .select()
        .from(projections)
        .where(eq(projections.jobId, input.jobId))
        .for("update");
      if (existing) {
        if (
          existing.environment !== input.environment ||
          existing.crawlJobId !== current.crawlJobId
        )
          throw new Error("FINALIZATION_REFERENCE_MISMATCH");
        const same =
          existing.counts.fetched === input.counts.fetched &&
          existing.counts.succeeded === input.counts.succeeded &&
          existing.counts.failed === input.counts.failed &&
          existing.counts.cancelled === input.counts.cancelled &&
          existing.errorCode === input.errorCode;
        if (
          existing.countVersion > input.countVersion ||
          (existing.countVersion === input.countVersion && !same)
        )
          throw new Error("COUNT_VERSION_CONFLICT");
        if (existing.countVersion === input.countVersion)
          return {
            output: { kind: "stage", response },
            effectiveModel: "",
            usage: { inputTokens: 0, outputTokens: 0 },
          };
        if (
          job.status === "succeeded" &&
          (input.counts.failed > 0 || input.counts.cancelled > 0 || input.errorCode !== null)
        )
          throw new Error("COUNT_VERSION_CONFLICT");
        await tx
          .update(projections)
          .set({
            countVersion: input.countVersion,
            counts: input.counts,
            errorCode: input.errorCode,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(projections.jobId, input.jobId));
      } else
        await tx.insert(projections).values({
          jobId: input.jobId,
          environment: input.environment,
          crawlJobId: current.crawlJobId,
          countVersion: input.countVersion,
          counts: input.counts,
          errorCode: input.errorCode,
        });
      const failedCount = input.counts.failed + input.counts.cancelled;
      await tx
        .update(crawlJobs)
        .set({
          fetchedCount: input.counts.fetched,
          failedCount,
          finishedAt: sql`clock_timestamp()`,
          status: failedCount > 0 || input.errorCode !== null ? "failed" : "succeeded",
          errorSummary: input.errorCode ?? (failedCount > 0 ? "PARTIAL_FAILURE" : null),
        })
        .where(eq(crawlJobs.id, current.crawlJobId));
      return {
        output: { kind: "stage", response },
        effectiveModel: "",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    });
    return response;
  }
}
