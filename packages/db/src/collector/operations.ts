import {
  environmentSchema,
  errorCodeSchema,
  hashSchema,
  operationKey as computeOperationKey,
  referenceIdSchema,
  resultWriteSchema,
  tokenUsageSchema,
  type BatchEnvironment,
  type OperationKeyInput,
  type OperationStatus,
} from "@upto/domain/batch";
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

import type { DbClient } from "../client.js";
import type { DbTransaction } from "./database-types.js";

import {
  collectorApiAttempts as attempts,
  collectorOperations as operations,
  collectorResults as results,
} from "./schema.js";
export type { DbTransaction } from "./database-types.js";
import {
  acquireGeneration,
  assertGenerationOwner,
  assertPublishedGeneration,
  lockGeneration,
  markGenerationUncertain,
  releaseGeneration,
} from "./generation-lease.js";
export type OperationFence = {
  environment: BatchEnvironment;
  operationKey: string;
  leaseOwner: string;
  leaseEpoch: number;
};
export type ClaimedOperation = {
  status: "claimed";
  fence: OperationFence;
  leaseUntil: Date;
  apiAttempt: number;
};
export type OperationClaim = ClaimedOperation | OperationStatus;
export type ClaimOperationInput = OperationKeyInput & {
  operationKey: string;
  owner: string;
  leaseMs: number;
  generationId?: string;
};
type OperationRow = typeof operations.$inferSelect;
export type ResultWrite = {
  output: unknown;
  effectiveModel: string;
  usage: { inputTokens: number; outputTokens: number };
};

function location(environment: BatchEnvironment, key: string) {
  environmentSchema.parse(environment);
  hashSchema.parse(key);
  return and(eq(operations.environment, environment), eq(operations.operationKey, key));
}
function ownerPredicate(fence: OperationFence) {
  if (!Number.isSafeInteger(fence.leaseEpoch) || fence.leaseEpoch < 1 || !fence.leaseOwner)
    throw new Error("INVALID_OPERATION_FENCE");
  return and(
    location(fence.environment, fence.operationKey),
    eq(operations.status, "running"),
    eq(operations.leaseEpoch, fence.leaseEpoch),
    eq(operations.leaseOwner, fence.leaseOwner),
    sql`${operations.leaseUntil} > clock_timestamp()`,
  );
}
function claimed(row: OperationRow): ClaimedOperation {
  if (!row.leaseOwner || !row.leaseUntil) throw new Error("INVALID_OPERATION_LEASE");
  return {
    status: "claimed",
    fence: {
      environment: row.environment,
      operationKey: row.operationKey,
      leaseOwner: row.leaseOwner,
      leaseEpoch: row.leaseEpoch,
    },
    leaseUntil: row.leaseUntil,
    apiAttempt: row.apiAttempt,
  };
}
function statusOf(row: OperationRow): OperationStatus {
  switch (row.status) {
    case "succeeded":
      if (!row.resultId) throw new Error("INVALID_OPERATION_RESULT");
      return { status: "succeeded", resultId: row.resultId };
    case "running":
      if (!row.leaseUntil) throw new Error("INVALID_OPERATION_LEASE");
      return { status: "running", leaseUntil: row.leaseUntil.toISOString() };
    case "waiting":
      if (!row.nextEligibleAt || !row.errorCode) throw new Error("INVALID_OPERATION_WAIT");
      return {
        status: "waiting",
        reason: row.errorCode,
        nextEligibleAt: row.nextEligibleAt.toISOString(),
      };
    case "failed":
      return { status: "failed", errorCode: row.errorCode ?? "OPERATION_FAILED", retryable: false };
    case "uncertain":
      return { status: "uncertain" };
  }
}

export class OperationRepository {
  constructor(private readonly db: DbClient) {}

  async claim(input: ClaimOperationInput): Promise<OperationClaim> {
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.owner) ||
      !Number.isSafeInteger(input.leaseMs) ||
      input.leaseMs < 1000 ||
      input.leaseMs > 360000
    )
      throw new Error("INVALID_OPERATION_CLAIM");
    if (input.generationId !== undefined) referenceIdSchema.parse(input.generationId);
    hashSchema.parse(input.operationKey);
    const identity: OperationKeyInput = {
      environment: input.environment,
      stage: input.stage,
      logicalEntityId: input.logicalEntityId,
      inputHash: input.inputHash,
      model: input.model,
      promptVersion: input.promptVersion,
      schemaVersion: input.schemaVersion,
    };
    if ((await computeOperationKey(identity)) !== input.operationKey)
      throw new Error("OPERATION_INPUT_CONFLICT");
    return this.db
      .transaction(async (tx) => {
        const generation =
          input.generationId === undefined
            ? null
            : await lockGeneration(tx, input.environment, input.generationId);
        if (
          generation &&
          (generation.promptVersion !== input.promptVersion ||
            generation.schemaVersion !== input.schemaVersion)
        )
          throw new Error("GENERATION_REFERENCE_MISMATCH");
        const [existing] = await tx
          .select()
          .from(operations)
          .where(location(input.environment, input.operationKey))
          .for("update");
        if (existing) {
          if (
            existing.generationId !== (input.generationId ?? null) ||
            existing.stage !== input.stage ||
            existing.inputHash !== input.inputHash ||
            existing.model !== input.model ||
            existing.logicalEntityId !== input.logicalEntityId ||
            existing.promptVersion !== input.promptVersion ||
            existing.schemaVersion !== input.schemaVersion
          )
            throw new Error("OPERATION_INPUT_CONFLICT");
          const current = await this.recoverUncertain(tx, existing);
          if (current.status !== "running" && current.status !== "waiting")
            return statusOf(current);
          const [timing] = await tx
            .select({
              expired: sql<boolean>`${operations.leaseUntil} <= clock_timestamp()`,
              due: sql<boolean>`${operations.nextEligibleAt} <= clock_timestamp()`,
            })
            .from(operations)
            .where(location(input.environment, input.operationKey));
          if (
            (current.status === "running" && !timing?.expired) ||
            (current.status === "waiting" && !timing?.due)
          )
            return statusOf(current);
        }
        let generationEpoch: number | null = null;
        if (generation) {
          const ownership = await acquireGeneration(
            tx,
            await lockGeneration(tx, input.environment, generation.id),
            input.owner,
            input.leaseMs,
          );
          if (ownership.status !== "claimed") return ownership;
          generationEpoch = ownership.epoch;
        }
        if (existing) {
          const [updated] = await tx
            .update(operations)
            .set({
              status: "running",
              leaseOwner: input.owner,
              leaseEpoch: sql`${operations.leaseEpoch} + 1`,
              generationEpoch,
              leaseUntil: sql`clock_timestamp() + (${input.leaseMs} * interval '1 millisecond')`,
              nextEligibleAt: null,
              errorCode: null,
              updatedAt: sql`clock_timestamp()`,
            })
            .where(
              and(
                location(input.environment, input.operationKey),
                eq(operations.leaseEpoch, existing.leaseEpoch),
              ),
            )
            .returning();
          if (!updated) throw new Error("STALE_OPERATION_OWNER");
          return claimed(updated);
        }
        const [inserted] = await tx
          .insert(operations)
          .values({
            ...identity,
            operationKey: input.operationKey,
            generationId: input.generationId ?? null,
            generationEpoch,
            leaseOwner: input.owner,
            leaseUntil: sql`clock_timestamp() + (${input.leaseMs} * interval '1 millisecond')`,
          })
          .onConflictDoNothing()
          .returning();
        if (inserted) return claimed(inserted);
        // Non-generation operations can race on the first insert. Re-enter through the existing-row path.
        throw new ClaimCollision();
      })
      .catch((error) => {
        if (error instanceof ClaimCollision) return this.claim(input);
        throw error;
      });
  }

  async status(environment: BatchEnvironment, key: string): Promise<OperationStatus> {
    return this.db.transaction(async (tx) => {
      const [target] = await tx.select().from(operations).where(location(environment, key));
      if (target?.generationId) await lockGeneration(tx, environment, target.generationId);
      const [row] = await tx
        .select()
        .from(operations)
        .where(location(environment, key))
        .for("update");
      return row ? statusOf(await this.recoverUncertain(tx, row)) : { status: "not_found" };
    });
  }

  // An expired owner that may have sent Gemini must never be replaced automatically.
  private async recoverUncertain(tx: DbTransaction, row: OperationRow): Promise<OperationRow> {
    if (row.status !== "running") return row;
    const [expired] = await tx
      .select({ expired: sql<boolean>`${operations.leaseUntil} <= clock_timestamp()` })
      .from(operations)
      .where(location(row.environment, row.operationKey));
    if (!expired?.expired) return row;
    const [unresolved] = await tx
      .select()
      .from(attempts)
      .where(
        and(
          eq(attempts.environment, row.environment),
          eq(attempts.operationKey, row.operationKey),
          sql`${attempts.status} IN ('sent', 'uncertain')`,
        ),
      )
      .limit(1);
    if (!unresolved) return row;
    await markGenerationUncertain(tx, row);
    await tx
      .update(attempts)
      .set({
        status: "uncertain",
        errorCode: "GENERATION_OUTCOME_UNKNOWN",
        finishedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(attempts.environment, row.environment),
          eq(attempts.operationKey, row.operationKey),
          eq(attempts.status, "sent"),
        ),
      );
    const [updated] = await tx
      .update(operations)
      .set({
        status: "uncertain",
        leaseOwner: null,
        leaseUntil: null,
        errorCode: "GENERATION_OUTCOME_UNKNOWN",
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          location(row.environment, row.operationKey),
          eq(operations.status, "running"),
          eq(operations.leaseEpoch, row.leaseEpoch),
        ),
      )
      .returning();
    if (!updated) throw new Error("STALE_OPERATION_OWNER");
    return updated;
  }

  private async owned(tx: DbTransaction, fence: OperationFence): Promise<OperationRow> {
    const [target] = await tx
      .select()
      .from(operations)
      .where(location(fence.environment, fence.operationKey));
    if (target?.generationId) await lockGeneration(tx, fence.environment, target.generationId);
    const [row] = await tx.select().from(operations).where(ownerPredicate(fence)).for("update");
    if (!row) throw new Error("STALE_OPERATION_OWNER");
    await assertGenerationOwner(tx, row);
    return row;
  }

  async markSent(
    fence: OperationFence,
    input: {
      attempt: number;
      permitId: string;
      reservedTokens: number;
      countVersion: string;
      quotaVersion: string;
    },
  ): Promise<void> {
    referenceIdSchema.parse(input.permitId);
    if (
      !Number.isInteger(input.attempt) ||
      input.attempt < 1 ||
      input.attempt > 3 ||
      !Number.isSafeInteger(input.reservedTokens) ||
      input.reservedTokens < 0 ||
      input.reservedTokens > 2147483647 ||
      !input.countVersion ||
      !input.quotaVersion
    )
      throw new Error("INVALID_API_ATTEMPT");
    await this.db.transaction(async (tx) => {
      const row = await this.owned(tx, fence);
      if (row.stage !== "summarize-chunk" && row.stage !== "merge-summary")
        throw new Error("API_ATTEMPT_STAGE_MISMATCH");
      if (input.attempt !== row.apiAttempt + 1) throw new Error("API_ATTEMPT_CONFLICT");
      const [unresolved] = await tx
        .select()
        .from(attempts)
        .where(
          and(
            eq(attempts.environment, fence.environment),
            eq(attempts.operationKey, fence.operationKey),
            sql`${attempts.status} IN ('sent', 'uncertain')`,
          ),
        )
        .limit(1);
      if (unresolved) throw new Error("API_ATTEMPT_UNRESOLVED");
      const [inserted] = await tx
        .insert(attempts)
        .values({
          ...input,
          environment: fence.environment,
          operationKey: fence.operationKey,
          leaseEpoch: fence.leaseEpoch,
        })
        .onConflictDoNothing()
        .returning();
      if (!inserted) throw new Error("API_PERMIT_CONFLICT");
      const [updated] = await tx
        .update(operations)
        .set({ apiAttempt: input.attempt, updatedAt: sql`clock_timestamp()` })
        .where(ownerPredicate(fence))
        .returning();
      if (!updated) throw new Error("STALE_OPERATION_OWNER");
      await assertGenerationOwner(tx, row);
    });
  }

  async complete(
    fence: OperationFence,
    input: ResultWrite | ((tx: DbTransaction) => Promise<ResultWrite>),
    write?: (tx: DbTransaction, resultId: string) => Promise<void>,
  ): Promise<string> {
    const prepared = typeof input === "function" ? null : resultWriteSchema.parse(input);
    return this.db.transaction(async (tx) => {
      const row = await this.owned(tx, fence);
      const value =
        prepared ?? resultWriteSchema.parse(typeof input === "function" ? await input(tx) : input);
      const outputHash = createHash("sha256").update(JSON.stringify(value.output)).digest("hex");
      if (
        ["discovery", "extract", "persist", "job-finalize"].includes(row.stage) &&
        !write &&
        typeof input !== "function"
      )
        throw new Error("STAGE_TRANSACTION_REQUIRED");
      const generates = row.stage === "summarize-chunk" || row.stage === "merge-summary";
      if (
        generates &&
        (value.output.kind === "stage" ||
          (row.stage === "merge-summary" && value.output.kind !== "summary"))
      )
        throw new Error("RESULT_STAGE_MISMATCH");
      if (
        !generates &&
        (value.output.kind !== "stage" || value.output.response.stage !== row.stage)
      )
        throw new Error("RESULT_STAGE_MISMATCH");
      if (value.effectiveModel !== row.model) throw new Error("RESULT_MODEL_MISMATCH");
      if (generates) {
        const [updated] = await tx
          .update(attempts)
          .set({ status: "succeeded", usage: value.usage, finishedAt: sql`clock_timestamp()` })
          .where(
            and(
              eq(attempts.environment, fence.environment),
              eq(attempts.operationKey, fence.operationKey),
              eq(attempts.attempt, row.apiAttempt),
              eq(attempts.leaseEpoch, fence.leaseEpoch),
              eq(attempts.status, "sent"),
            ),
          )
          .returning();
        if (!updated) throw new Error("API_ATTEMPT_REQUIRED");
      }
      const [result] = await tx
        .insert(results)
        .values({
          environment: row.environment,
          operationKey: row.operationKey,
          generationId: row.generationId,
          validatedJson: value.output,
          usage: value.usage,
          effectiveModel: value.effectiveModel,
          outputHash,
        })
        .returning();
      if (!result) throw new Error("RESULT_SAVE_FAILED");
      if (write) await write(tx, result.id);
      await assertPublishedGeneration(tx, row, value.output);
      const [updated] = await tx
        .update(operations)
        .set({
          status: "succeeded",
          resultId: result.id,
          leaseOwner: null,
          leaseUntil: null,
          errorCode: null,
          nextEligibleAt: null,
          terminalAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(ownerPredicate(fence))
        .returning();
      if (!updated) throw new Error("STALE_OPERATION_OWNER");
      await releaseGeneration(tx, row, row.stage === "persist");
      return result.id;
    });
  }

  // Only the sender that has not invoked generate may withdraw a committed send marker.
  // A lost markSent response or any possible API send must use uncertain instead.
  async withdrawUnsent(
    fence: OperationFence,
    permitId: string,
    nextEligibleAt: Date,
    reason: string,
  ): Promise<void> {
    referenceIdSchema.parse(permitId);
    errorCodeSchema.parse(reason);
    if (!Number.isFinite(nextEligibleAt.getTime())) throw new Error("INVALID_WAIT_DEADLINE");
    await this.db.transaction(async (tx) => {
      const row = await this.owned(tx, fence);
      const [removed] = await tx
        .delete(attempts)
        .where(
          and(
            eq(attempts.environment, fence.environment),
            eq(attempts.operationKey, fence.operationKey),
            eq(attempts.attempt, row.apiAttempt),
            eq(attempts.leaseEpoch, fence.leaseEpoch),
            eq(attempts.permitId, permitId),
            eq(attempts.status, "sent"),
          ),
        )
        .returning();
      if (!removed) throw new Error("API_ATTEMPT_REQUIRED");
      const [updated] = await tx
        .update(operations)
        .set({
          status: "waiting",
          apiAttempt: row.apiAttempt - 1,
          nextEligibleAt,
          errorCode: reason,
          leaseOwner: null,
          leaseUntil: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(ownerPredicate(fence))
        .returning();
      if (!updated) throw new Error("STALE_OPERATION_OWNER");
      await releaseGeneration(tx, row);
    });
  }

  async wait(fence: OperationFence, nextEligibleAt: Date, reason: string): Promise<void> {
    errorCodeSchema.parse(reason);
    if (!Number.isFinite(nextEligibleAt.getTime())) throw new Error("INVALID_WAIT_DEADLINE");
    await this.db.transaction(async (tx) => {
      const row = await this.owned(tx, fence);
      const [unresolved] = await tx
        .select()
        .from(attempts)
        .where(
          and(
            eq(attempts.environment, fence.environment),
            eq(attempts.operationKey, fence.operationKey),
            sql`${attempts.status} IN ('sent', 'uncertain')`,
          ),
        )
        .limit(1);
      if (unresolved) throw new Error("API_ATTEMPT_UNRESOLVED");
      const [updated] = await tx
        .update(operations)
        .set({
          status: "waiting",
          nextEligibleAt,
          errorCode: reason,
          leaseOwner: null,
          leaseUntil: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(ownerPredicate(fence))
        .returning();
      if (!updated) throw new Error("STALE_OPERATION_OWNER");
      await releaseGeneration(tx, row);
    });
  }

  async fail(
    fence: OperationFence,
    errorCode: string,
    usage?: { inputTokens: number; outputTokens: number },
  ): Promise<void> {
    errorCodeSchema.parse(errorCode);
    const parsedUsage = usage === undefined ? undefined : tokenUsageSchema.parse(usage);
    await this.db.transaction(async (tx) => {
      const row = await this.owned(tx, fence);
      await tx
        .update(attempts)
        .set({
          status: "failed",
          errorCode,
          finishedAt: sql`clock_timestamp()`,
          ...(parsedUsage === undefined ? {} : { usage: parsedUsage }),
        })
        .where(
          and(
            eq(attempts.environment, fence.environment),
            eq(attempts.operationKey, fence.operationKey),
            eq(attempts.attempt, row.apiAttempt),
            eq(attempts.status, "sent"),
          ),
        );
      const [updated] = await tx
        .update(operations)
        .set({
          status: "failed",
          errorCode,
          leaseOwner: null,
          leaseUntil: null,
          terminalAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(ownerPredicate(fence))
        .returning();
      if (!updated) throw new Error("STALE_OPERATION_OWNER");
      await releaseGeneration(tx, row);
    });
  }

  async uncertain(fence: OperationFence): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await this.owned(tx, fence);
      const [attempt] = await tx
        .update(attempts)
        .set({
          status: "uncertain",
          errorCode: "GENERATION_OUTCOME_UNKNOWN",
          finishedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(attempts.environment, fence.environment),
            eq(attempts.operationKey, fence.operationKey),
            eq(attempts.attempt, row.apiAttempt),
            eq(attempts.leaseEpoch, fence.leaseEpoch),
            eq(attempts.status, "sent"),
          ),
        )
        .returning();
      if (!attempt) throw new Error("API_ATTEMPT_REQUIRED");
      const [updated] = await tx
        .update(operations)
        .set({
          status: "uncertain",
          errorCode: "GENERATION_OUTCOME_UNKNOWN",
          leaseOwner: null,
          leaseUntil: null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(ownerPredicate(fence))
        .returning();
      if (!updated) throw new Error("STALE_OPERATION_OWNER");
      await markGenerationUncertain(tx, row);
    });
  }

  async rateLimited(fence: OperationFence, nextEligibleAt: Date): Promise<void> {
    if (!Number.isFinite(nextEligibleAt.getTime())) throw new Error("INVALID_WAIT_DEADLINE");
    await this.db.transaction(async (tx) => {
      const row = await this.owned(tx, fence);
      const [attempt] = await tx
        .update(attempts)
        .set({
          status: "rate_limited",
          errorCode: "GEMINI_RATE_LIMITED",
          finishedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            eq(attempts.environment, fence.environment),
            eq(attempts.operationKey, fence.operationKey),
            eq(attempts.attempt, row.apiAttempt),
            eq(attempts.leaseEpoch, fence.leaseEpoch),
            eq(attempts.status, "sent"),
          ),
        )
        .returning();
      if (!attempt) throw new Error("API_ATTEMPT_REQUIRED");
      const exhausted = row.apiAttempt >= 3;
      const [updated] = await tx
        .update(operations)
        .set({
          status: exhausted ? "failed" : "waiting",
          nextEligibleAt: exhausted ? null : nextEligibleAt,
          errorCode: exhausted ? "API_ATTEMPTS_EXHAUSTED" : "GEMINI_RATE_LIMITED",
          leaseOwner: null,
          leaseUntil: null,
          terminalAt: exhausted ? sql`clock_timestamp()` : null,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(ownerPredicate(fence))
        .returning();
      if (!updated) throw new Error("STALE_OPERATION_OWNER");
      await releaseGeneration(tx, row);
    });
  }
}

class ClaimCollision extends Error {}
