import {
  createAuthenticator,
  RequestAuthError,
  MAX_CONTROL_REQUEST_BYTES,
  MAX_CONTROL_RESPONSE_BYTES,
  manifestQuerySchema,
  manifestResponseSchema,
  operationStatusQuerySchema,
  operationStatusSchema,
  stageRequestSchema,
  stageResponseSchema,
  prepareRequestSchema,
  prepareResponseSchema,
  type PrepareRequest,
  type PrepareResponse,
  type AuthContext,
  type BatchEnvironment,
  type NonceInput,
  type OperationStatus,
  type StageRequest,
  type StageResponse,
  type ManifestEntry,
} from "@upto/domain/batch";
import { randomUUID } from "node:crypto";

import type { BatchObserver, BatchLogRecord } from "../observability.js";

export type ManifestQuery = {
  apiVersion: "v1";
  environment: BatchEnvironment;
  manifestId: string;
  limit: number;
  cursor?: string;
};
export type StatusQuery = { apiVersion: "v1"; environment: BatchEnvironment; operationKey: string };
export type HttpExecutionContext = {
  auth: AuthContext;
  signal: AbortSignal;
  deadlineAt: number;
  assertTimeLeft(): void;
};
export type CollectorHttpServices = {
  prepare?(request: PrepareRequest, context: HttpExecutionContext): Promise<PrepareResponse>;
  replay(request: StageRequest, context: HttpExecutionContext): Promise<StageResponse | null>;
  execute(request: StageRequest, context: HttpExecutionContext): Promise<StageResponse>;
  manifests(
    query: ManifestQuery,
    context: HttpExecutionContext,
  ): Promise<{ manifestId: string; entries: ManifestEntry[]; nextCursor: string | null }>;
  operationStatus(query: StatusQuery, context: HttpExecutionContext): Promise<OperationStatus>;
};
class BoundaryError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
const conflicts = new Set([
  "SUMMARY_RESULTS_INCOMPLETE",
  "SUMMARY_INPUT_TOO_LARGE",
  "SUMMARY_REFERENCE_MISMATCH",
  "API_ATTEMPT_CONFLICT",
  "DISCOVERY_SLOT_CONFLICT",
  "DISCOVERY_CONFIG_CONFLICT",
  "EXTRACTION_REFERENCE_MISMATCH",
  "FINALIZATION_REFERENCE_MISMATCH",
  "COUNT_VERSION_CONFLICT",
  "PUBLICATION_REFERENCE_MISMATCH",
  "PUBLICATION_VERSION_MISMATCH",
  "PUBLICATION_RESULT_INCOMPLETE",
  "OPERATION_INPUT_CONFLICT",
  "GENERATION_VERSION_CONFLICT",
  "GENERATION_REFERENCE_MISMATCH",
  "STALE_OPERATION_OWNER",
  "STALE_GENERATION_OWNER",
  "RESULT_REFERENCE_MISMATCH",
  "EXTRACTION_SNAPSHOT_CONFLICT",
  "MANIFEST_CURSOR_INVALID",
  "MANIFEST_REFERENCE_MISMATCH",
  "MANIFEST_SNAPSHOT_CONFLICT",
  "GENERATION_TERMINAL",
]);
function causeCode(error: unknown): BatchLogRecord["causeCode"] {
  if (typeof error !== "object" || error === null) return "UNKNOWN_FAILURE";
  const code = "code" in error ? error.code : undefined;
  if (code === "53300") return "DATABASE_CAPACITY_EXHAUSTED";
  if (code === "57014") return "DATABASE_STATEMENT_TIMEOUT";
  if (["08000", "08001", "08003", "08006", "57P01", "57P03"].includes(String(code)))
    return "DATABASE_CONNECTION_FAILED";
  if (["23502", "23503", "23505", "23514"].includes(String(code)))
    return "DATABASE_CONSTRAINT_FAILED";
  if (["ECONNREFUSED", "ETIMEDOUT", "ENOTFOUND", "ECONNRESET"].includes(String(code)))
    return "NETWORK_FAILURE";
  // Drizzle wraps driver errors in cause. Never log the query or parameters.
  if (
    "cause" in error &&
    error.cause !== error &&
    typeof error.cause === "object" &&
    error.cause !== null
  ) {
    const nested = "code" in error.cause ? error.cause.code : undefined;
    return causeCode({ code: nested });
  }
  return "UNKNOWN_FAILURE";
}
const missing = new Set(["MANIFEST_NOT_FOUND", "ARTICLE_NOT_FOUND", "OPERATION_NOT_FOUND"]);
async function readBody(request: Request, signal: AbortSignal): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^(0|[1-9]\d*)$/.test(declared) || Number(declared) > MAX_CONTROL_REQUEST_BYTES)
  )
    throw new BoundaryError("REQUEST_BODY_TOO_LARGE", 413);
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let cancelled: Promise<void> | undefined;
  const abort = () => {
    cancelled = reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw new BoundaryError("REQUEST_DEADLINE_EXCEEDED", 408);
    while (true) {
      const part = await reader.read();
      if (signal.aborted) throw new BoundaryError("REQUEST_DEADLINE_EXCEEDED", 408);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_CONTROL_REQUEST_BYTES) {
        await reader.cancel();
        throw new BoundaryError("REQUEST_BODY_TOO_LARGE", 413);
      }
      chunks.push(part.value);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return body;
  } finally {
    signal.removeEventListener("abort", abort);
    await cancelled;
    reader.releaseLock();
  }
}
function queryObject(url: URL): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, value] of url.searchParams) {
    if (Object.hasOwn(result, key)) throw new BoundaryError("REQUEST_QUERY_INVALID", 400);
    if (key === "limit") {
      if (!/^[1-9]\d*$/.test(value)) throw new BoundaryError("REQUEST_QUERY_INVALID", 400);
      result[key] = Number(value);
    } else result[key] = value;
  }
  return result;
}
function jsonResponse(value: unknown, status: number, requestId: string): Response {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > MAX_CONTROL_RESPONSE_BYTES)
    throw new BoundaryError("EXECUTOR_RESPONSE_TOO_LARGE", 503);
  return new Response(body, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-upto-request-id": requestId,
    },
  });
}
export function createCollectorHandler(options: {
  environment: BatchEnvironment;
  executorVersions: readonly string[];
  configVersions: readonly string[];
  keys: ReadonlyMap<string, Uint8Array>;
  consumeNonce(input: NonceInput): Promise<boolean>;
  services: CollectorHttpServices;
  timeoutMs?: number;
  observer?: BatchObserver;
  logger?: (record: { errorCode: string; requestId: string }) => void;
}) {
  const timeoutMs = options.timeoutMs ?? 240000;
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 240000 ||
    options.configVersions.length === 0 ||
    options.configVersions.some((value) => !value || value.length > 128)
  )
    throw new Error("HTTP_CONFIGURATION_INVALID");
  const configs = new Set(options.configVersions);
  const auth = createAuthenticator({
    environment: options.environment,
    direction: "cf-to-node",
    allowedExecutorVersions: options.executorVersions,
    keys: options.keys,
    consumeNonce: options.consumeNonce,
  });
  return async (request: Request): Promise<Response> => {
    let requestId: string = randomUUID();
    const startedAt = Date.now();
    let metadata: Partial<BatchLogRecord> = {};
    async function observe(record: BatchLogRecord) {
      try {
        await options.observer?.({
          environment: options.environment,
          requestId,
          ...metadata,
          ...record,
        });
      } catch {
        /* Observability must not affect the HTTP result. */
      }
    }
    function identify(input: StageRequest | PrepareRequest) {
      metadata = {
        stage: input.stage,
        jobId: input.jobId,
        workId: input.workId,
        executorVersion: input.executorVersion,
        configVersion: input.configVersion,
        ...("operationKey" in input ? { operationKey: input.operationKey } : {}),
        ...("generationId" in input ? { generationId: input.generationId } : {}),
        ...("apiAttempt" in input ? { apiAttempt: input.apiAttempt } : {}),
      };
    }
    async function finished(
      value: StageResponse | OperationStatus,
      replay = false,
      input?: StageRequest,
    ) {
      await observe({
        event: "stage_finished",
        status: value.status,
        replay,
        durationMs: Date.now() - startedAt,
        ...("errorCode" in value ? { errorCode: value.errorCode, retryable: value.retryable } : {}),
        ...("reason" in value
          ? { errorCode: value.reason, nextEligibleAt: value.nextEligibleAt }
          : {}),
        ...(input?.stage === "job-finalize"
          ? {
              failedCount: input.counts.failed,
              cancelledCount: input.counts.cancelled,
              ...(input.errorCode ? { errorCode: input.errorCode } : {}),
            }
          : {}),
      });
    }
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, request.signal]);
    const handlerDeadline = Date.now() + timeoutMs;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let stageTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const body = await readBody(request, signal);
      const verified = await auth.verify({
        method: request.method,
        url: request.url,
        body,
        headers: request.headers,
      });
      requestId = verified.requestId;
      const url = new URL(request.url);
      const context: HttpExecutionContext = {
        auth: verified,
        signal,
        deadlineAt: handlerDeadline,
        assertTimeLeft() {
          if (signal.aborted || Date.now() >= context.deadlineAt)
            throw new BoundaryError("REQUEST_DEADLINE_EXCEEDED", 408);
        },
      };
      if (request.method === "GET") {
        context.assertTimeLeft();
        if (body.byteLength !== 0) throw new BoundaryError("REQUEST_BODY_INVALID", 400);
        const query = queryObject(url);
        if (url.pathname === "/api/v1/manifests") {
          metadata = { stage: "manifests" };
          const parsed = manifestQuerySchema.safeParse(query);
          if (!parsed.success) throw new BoundaryError("REQUEST_QUERY_INVALID", 400);
          if (parsed.data.environment !== verified.environment)
            throw new BoundaryError("REQUEST_SCOPE_INVALID", 403);
          const response = manifestResponseSchema.safeParse(
            await options.services.manifests(
              {
                apiVersion: parsed.data.apiVersion,
                environment: parsed.data.environment,
                manifestId: parsed.data.manifestId,
                limit: parsed.data.limit,
                ...(parsed.data.cursor === undefined ? {} : { cursor: parsed.data.cursor }),
              },
              context,
            ),
          );
          context.assertTimeLeft();
          if (!response.success) throw new BoundaryError("EXECUTOR_RESPONSE_INVALID", 503);
          await observe({
            event: "stage_finished",
            status: "succeeded",
            durationMs: Date.now() - startedAt,
          });
          return jsonResponse(response.data, 200, requestId);
        }
        const parsed = operationStatusQuerySchema.safeParse(query);
        if (!parsed.success) throw new BoundaryError("REQUEST_QUERY_INVALID", 400);
        if (parsed.data.environment !== verified.environment)
          throw new BoundaryError("REQUEST_SCOPE_INVALID", 403);
        metadata = { stage: "operation-status", operationKey: parsed.data.operationKey };
        const response = operationStatusSchema.safeParse(
          await options.services.operationStatus(parsed.data, context),
        );
        context.assertTimeLeft();
        if (!response.success) throw new BoundaryError("EXECUTOR_RESPONSE_INVALID", 503);
        await finished(response.data);
        return jsonResponse(response.data, 200, requestId);
      }
      if (url.search !== "") throw new BoundaryError("REQUEST_QUERY_INVALID", 400);
      if (
        request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
        "application/json"
      )
        throw new BoundaryError("REQUEST_CONTENT_TYPE_INVALID", 415);
      let raw: unknown;
      try {
        raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      } catch {
        throw new BoundaryError("REQUEST_BODY_INVALID", 400);
      }
      if (url.pathname === "/api/v1/prepare") {
        const parsed = prepareRequestSchema.safeParse(raw);
        if (!parsed.success) throw new BoundaryError("REQUEST_CONTRACT_INVALID", 400);
        const input = parsed.data;
        if (
          input.environment !== verified.environment ||
          input.executorVersion !== verified.executorVersion
        )
          throw new BoundaryError("REQUEST_SCOPE_INVALID", 403);
        identify(input);
        if (!configs.has(input.configVersion))
          throw new BoundaryError("REQUEST_CONFIG_INVALID", 409);
        await observe({ event: "stage_started", status: "started" });
        context.deadlineAt = Math.min(handlerDeadline, Date.parse(input.deadlineAt));
        context.assertTimeLeft();
        stageTimer = setTimeout(() => controller.abort(), context.deadlineAt - Date.now());
        if (!options.services.prepare) throw new BoundaryError("PREPARE_UNAVAILABLE", 503);
        const response = prepareResponseSchema.safeParse(
          await options.services.prepare(input, context),
        );
        context.assertTimeLeft();
        if (
          !response.success ||
          response.data.stage !== input.stage ||
          ("generationId" in input && response.data.generationId !== input.generationId)
        )
          throw new BoundaryError("EXECUTOR_RESPONSE_INVALID", 503);
        await observe({
          event: "stage_finished",
          status: "succeeded",
          durationMs: Date.now() - startedAt,
        });
        return jsonResponse(response.data, 200, requestId);
      }
      const parsed = stageRequestSchema.safeParse(raw);
      if (!parsed.success) throw new BoundaryError("REQUEST_CONTRACT_INVALID", 400);
      const input = parsed.data;
      if (input.stage !== url.pathname.slice("/api/v1/".length))
        throw new BoundaryError("REQUEST_STAGE_INVALID", 400);
      if (
        input.environment !== verified.environment ||
        input.executorVersion !== verified.executorVersion
      )
        throw new BoundaryError("REQUEST_SCOPE_INVALID", 403);
      identify(input);
      if (!configs.has(input.configVersion)) throw new BoundaryError("REQUEST_CONFIG_INVALID", 409);
      await observe({ event: "stage_started", status: "started" });
      context.assertTimeLeft();
      const replay = await options.services.replay(input, context);
      context.assertTimeLeft();
      let value: StageResponse;
      if (replay !== null) value = replay;
      else {
        context.deadlineAt = Math.min(handlerDeadline, Date.parse(input.deadlineAt));
        context.assertTimeLeft();
        const remaining = context.deadlineAt - Date.now();
        const stageTimer = setTimeout(() => controller.abort(), remaining);
        try {
          value = await options.services.execute(input, context);
          context.assertTimeLeft();
        } finally {
          clearTimeout(stageTimer);
        }
      }
      const response = stageResponseSchema.safeParse(value);
      if (
        !response.success ||
        (response.data.status === "succeeded" && response.data.stage !== input.stage)
      )
        throw new BoundaryError("EXECUTOR_RESPONSE_INVALID", 503);
      await finished(response.data, replay !== null, input);
      return jsonResponse(response.data, 200, requestId);
    } catch (error) {
      let code = "EXECUTOR_FAILURE";
      let status = 503;
      if (error instanceof BoundaryError || error instanceof RequestAuthError) {
        code = error.code;
        status = error.status;
      } else if (error instanceof Error && conflicts.has(error.message)) {
        code = error.message;
        status = 409;
      } else if (error instanceof Error && missing.has(error.message)) {
        code = error.message;
        status = 404;
      }
      await observe({
        event: "request_failed",
        status: "failed",
        errorCode: code,
        ...(code === "EXECUTOR_FAILURE" ? { causeCode: causeCode(error) } : {}),
        httpStatus: status,
        retryable: status >= 500,
        durationMs: Date.now() - startedAt,
      });
      try {
        options.logger?.({ errorCode: code, requestId });
      } catch {
        /* Logging failure must not expose an underlying error. */
      }
      return jsonResponse(
        { status: "failed", errorCode: code, retryable: status >= 500 },
        status,
        requestId,
      );
    } finally {
      clearTimeout(stageTimer);
      clearTimeout(timer);
    }
  };
}
