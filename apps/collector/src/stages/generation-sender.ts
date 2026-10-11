import type { DbClient } from "@upto/db";

import { OperationRepository, ResultRepository } from "@upto/db/collector";
import {
  gateRequestSchema,
  gateReserveResponseSchema,
  gateConsumeResponseSchema,
  gateReportResponseSchema,
  operationOutputSchema,
  tokenUsageSchema,
  type OperationKeyInput,
  type StageResponse,
} from "@upto/domain/batch";
import { z } from "zod";

import type { BatchObserver } from "../observability.js";

type GateRequest = z.infer<typeof gateRequestSchema>;
type GenerateInput = {
  model: string;
  prompt: string;
  outputKind: "chunk" | "summary";
  maxOutputTokens: number;
  signal: AbortSignal;
};
export type GenerationDependencies = {
  observer?: BatchObserver;
  count(input: GenerateInput): Promise<unknown>;
  generate(input: GenerateInput): Promise<unknown>;
  gate: {
    reserve(
      input: Extract<GateRequest, { action: "reserve" }>,
      signal: AbortSignal,
    ): Promise<unknown>;
    consume(
      input: Extract<GateRequest, { action: "consume" }>,
      signal: AbortSignal,
    ): Promise<unknown>;
    report(
      input: Extract<GateRequest, { action: "report" }>,
      signal: AbortSignal,
    ): Promise<unknown>;
  };
};
export class GenerationTransportError extends Error {
  constructor(readonly outcome: "rate_limited" | "rejected") {
    super(outcome === "rate_limited" ? "GEMINI_RATE_LIMITED" : "GEMINI_REJECTED");
  }
}
async function bounded<T>(
  parent: AbortSignal,
  milliseconds: number,
  task: (signal: AbortSignal) => Promise<T>,
  acceptLateSuccess = false,
): Promise<T> {
  const controller = new AbortController();
  const signal = AbortSignal.any([parent, controller.signal]);
  const timer = setTimeout(() => controller.abort(), milliseconds);
  try {
    if (signal.aborted) throw new Error("REQUEST_DEADLINE_EXCEEDED");
    const result = await task(signal);
    if (signal.aborted && !acceptLateSuccess) throw new Error("REQUEST_DEADLINE_EXCEEDED");
    return result;
  } finally {
    clearTimeout(timer);
  }
}
export async function runGenerationOperation(
  db: DbClient,
  input: {
    identity: OperationKeyInput;
    operationKey: string;
    generationId: string;
    apiAttempt: number;
    owner: string;
    prompt: string;
    outputKind: "chunk" | "summary";
    maxOutputTokens: number;
    countVersion: string;
    signal: AbortSignal;
  },
  dependencies: GenerationDependencies,
): Promise<StageResponse> {
  if (
    !["summarize-chunk", "merge-summary"].includes(input.identity.stage) ||
    (input.identity.stage === "merge-summary" && input.outputKind !== "summary") ||
    !input.prompt.trim() ||
    new TextEncoder().encode(input.prompt).byteLength > 2 * 1024 * 1024 ||
    !input.countVersion ||
    input.countVersion.length > 128 ||
    !Number.isInteger(input.maxOutputTokens) ||
    input.maxOutputTokens < 1 ||
    input.maxOutputTokens > 32768 ||
    !Number.isInteger(input.apiAttempt) ||
    input.apiAttempt < 1 ||
    input.apiAttempt > 3
  )
    throw new Error("GENERATION_CONFIG_INVALID");
  if (input.signal.aborted) throw new Error("REQUEST_DEADLINE_EXCEEDED");
  const operations = new OperationRepository(db);
  const results = new ResultRepository(db);
  async function success(resultId: string): Promise<StageResponse> {
    const result = await results.read(input.identity.environment, resultId, input.generationId);
    if (!result || result.output.kind === "stage" || result.output.kind !== input.outputKind)
      throw new Error("RESULT_REFERENCE_MISMATCH");
    return input.identity.stage === "merge-summary"
      ? {
          status: "succeeded",
          stage: "merge-summary",
          finalResultId: result.id,
          schemaVersion: result.schemaVersion,
        }
      : {
          status: "succeeded",
          stage: "summarize-chunk",
          resultId: result.id,
          effectiveModel: result.effectiveModel,
          usageId: result.id,
        };
  }
  const claim = await operations.claim({
    ...input.identity,
    operationKey: input.operationKey,
    generationId: input.generationId,
    owner: input.owner,
    leaseMs: 360000,
  });
  if (claim.status === "succeeded") return success(claim.resultId);
  if (claim.status === "uncertain")
    return { status: "failed", errorCode: "GENERATION_OUTCOME_UNKNOWN", retryable: false };
  if (claim.status === "not_found") throw new Error("GENERATION_REFERENCE_MISMATCH");
  if (claim.status !== "claimed") return claim;
  const fence = claim.fence;
  async function wait(
    reason: string,
    when = new Date(Date.now() + 60000).toISOString(),
  ): Promise<StageResponse> {
    await operations.wait(fence, new Date(when), reason);
    return { status: "waiting", reason, nextEligibleAt: when };
  }
  if (input.apiAttempt !== claim.apiAttempt + 1) {
    await operations.wait(fence, new Date(), "API_ATTEMPT_CONFLICT");
    throw new Error("API_ATTEMPT_CONFLICT");
  }
  const generationInput = {
    model: input.identity.model,
    prompt: input.prompt,
    outputKind: input.outputKind,
    maxOutputTokens: input.maxOutputTokens,
  };
  let inputTokens: number;
  try {
    const counted = await bounded(input.signal, 10000, (signal) =>
      dependencies.count({ ...generationInput, signal }),
    );
    inputTokens = z
      .strictObject({ inputTokens: z.number().int().min(0).max(1900000000) })
      .parse(counted).inputTokens;
  } catch {
    return wait("TOKEN_COUNT_UNAVAILABLE");
  }
  const budget = Math.ceil(inputTokens * 1.1);
  const gateBase = {
    apiVersion: "v1" as const,
    environment: input.identity.environment,
    operationKey: input.operationKey,
    apiAttempt: input.apiAttempt,
  };
  let reservation: z.infer<typeof gateReserveResponseSchema>;
  try {
    reservation = gateReserveResponseSchema.parse(
      await bounded(input.signal, 10000, (signal) =>
        dependencies.gate.reserve(
          {
            ...gateBase,
            action: "reserve",
            model: input.identity.model,
            inputTokens: budget,
            outputTokenLimit: input.maxOutputTokens,
            reservationGeneration: fence.leaseEpoch,
          },
          signal,
        ),
      ),
    );
  } catch {
    return wait("GATE_UNAVAILABLE");
  }
  if (reservation.status === "waiting") return wait(reservation.reason, reservation.nextEligibleAt);
  const permit = reservation;
  if (Date.parse(permit.expiresAt) <= Date.now()) return wait("GATE_PERMIT_EXPIRED");
  let consumption: z.infer<typeof gateConsumeResponseSchema>;
  try {
    consumption = gateConsumeResponseSchema.parse(
      await bounded(input.signal, 10000, (signal) =>
        dependencies.gate.consume(
          { ...gateBase, action: "consume", permitId: permit.permitId },
          signal,
        ),
      ),
    );
  } catch {
    return wait("GATE_CONSUME_UNKNOWN");
  }
  if (consumption.status === "waiting") return wait(consumption.reason, consumption.nextEligibleAt);
  if (
    consumption.permitId !== permit.permitId ||
    Date.parse(permit.expiresAt) <= Date.now() ||
    input.signal.aborted
  )
    return wait("GATE_PERMIT_EXPIRED");
  async function report(
    outcome: Extract<GateRequest, { action: "report" }>["outcome"],
    usage = { inputTokens: 0, outputTokens: 0 },
  ) {
    try {
      gateReportResponseSchema.parse(
        await bounded(input.signal, 10000, (signal) =>
          dependencies.gate.report(
            gateRequestSchema.parse({
              ...gateBase,
              action: "report",
              permitId: permit.permitId,
              outcome,
              ...usage,
            }) as Extract<GateRequest, { action: "report" }>,
            signal,
          ),
        ),
      );
    } catch {
      // PG is authoritative; retain the reservation until reconciliation.
      try {
        await dependencies.observer?.({
          event: "gate_report_failed",
          environment: input.identity.environment,
          operationKey: input.operationKey,
          generationId: input.generationId,
          stage: input.identity.stage,
          apiAttempt: input.apiAttempt,
          errorCode: "GATE_REPORT_UNAVAILABLE",
        });
      } catch {
        /* Telemetry cannot change the generation outcome. */
      }
    }
  }
  try {
    await operations.markSent(fence, {
      attempt: input.apiAttempt,
      permitId: permit.permitId,
      reservedTokens: budget + input.maxOutputTokens,
      countVersion: input.countVersion,
      quotaVersion: permit.quotaVersion,
    });
  } catch (error) {
    await report("uncertain");
    throw error;
  }
  // The PG transaction can outlive the permit. No await is allowed between this
  // final check and invoking the transport below.
  if (Date.parse(permit.expiresAt) <= Date.now() || input.signal.aborted) {
    const reason = input.signal.aborted ? "REQUEST_DEADLINE_EXCEEDED" : "GATE_PERMIT_EXPIRED";
    const nextEligibleAt = new Date(Date.now() + 60000).toISOString();
    await operations.withdrawUnsent(fence, permit.permitId, new Date(nextEligibleAt), reason);
    await report("failed");
    return { status: "waiting", reason, nextEligibleAt };
  }
  let generated: unknown;
  try {
    generated = await bounded(
      input.signal,
      180000,
      (signal) => dependencies.generate({ ...generationInput, signal }),
      true,
    );
  } catch (error) {
    if (error instanceof GenerationTransportError && error.outcome === "rate_limited") {
      const nextEligibleAt = new Date(Date.now() + 60000).toISOString();
      await operations.rateLimited(fence, new Date(nextEligibleAt));
      await report("rate_limited");
      return input.apiAttempt >= 3
        ? { status: "failed", errorCode: "API_ATTEMPTS_EXHAUSTED", retryable: false }
        : { status: "waiting", reason: "GEMINI_RATE_LIMITED", nextEligibleAt };
    }
    if (error instanceof GenerationTransportError && error.outcome === "rejected") {
      await operations.fail(fence, "GEMINI_REJECTED");
      await report("failed");
      return { status: "failed", errorCode: "GEMINI_REJECTED", retryable: false };
    }
    await operations.uncertain(fence);
    await report("uncertain");
    return { status: "failed", errorCode: "GENERATION_OUTCOME_UNKNOWN", retryable: false };
  }
  const value = z
    .strictObject({ output: operationOutputSchema, usage: tokenUsageSchema })
    .safeParse(generated);
  if (!value.success || value.data.output.kind !== input.outputKind) {
    const usage = z.object({ usage: tokenUsageSchema }).safeParse(generated);
    await operations.fail(
      fence,
      "GENERATION_OUTPUT_INVALID",
      usage.success ? usage.data.usage : undefined,
    );
    await report("failed", usage.success ? usage.data.usage : undefined);
    return { status: "failed", errorCode: "GENERATION_OUTPUT_INVALID", retryable: false };
  }
  let resultId: string;
  try {
    resultId = await operations.complete(fence, {
      ...value.data,
      effectiveModel: input.identity.model,
    });
  } catch {
    const status = await operations.status(input.identity.environment, input.operationKey);
    if (status.status === "succeeded") {
      await report("succeeded", value.data.usage);
      return success(status.resultId);
    }
    await operations.uncertain(fence);
    await report("uncertain", value.data.usage);
    return { status: "failed", errorCode: "GENERATION_OUTCOME_UNKNOWN", retryable: false };
  }
  await report("succeeded", value.data.usage);
  return success(resultId);
}
