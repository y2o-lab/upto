import type { z } from "zod";

import {
  signRequest,
  gateRequestSchema,
  gateReserveResponseSchema,
  gateConsumeResponseSchema,
  gateReportResponseSchema,
  environmentSchema,
  MAX_CONTROL_REQUEST_BYTES,
  MAX_CONTROL_RESPONSE_BYTES,
  type BatchEnvironment,
  type GateReserveResponse,
  type GateConsumeResponse,
} from "@upto/domain/batch";

type GateRequest = z.infer<typeof gateRequestSchema>;
export type GateClient = {
  reserve(
    input: Extract<GateRequest, { action: "reserve" }>,
    signal: AbortSignal,
  ): Promise<GateReserveResponse>;
  consume(
    input: Extract<GateRequest, { action: "consume" }>,
    signal: AbortSignal,
  ): Promise<GateConsumeResponse>;
  report(
    input: Extract<GateRequest, { action: "report" }>,
    signal: AbortSignal,
  ): Promise<{ status: "reported" }>;
};
async function readBounded(response: Response, signal: AbortSignal): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    (!/^(0|[1-9]\d*)$/.test(declared) || Number(declared) > MAX_CONTROL_RESPONSE_BYTES)
  ) {
    await response.body?.cancel();
    throw new Error("GATE_RESPONSE_TOO_LARGE");
  }
  if (!response.body) throw new Error("GATE_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let cancellation: Promise<void> | undefined;
  const abort = () => {
    cancellation = reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    while (true) {
      if (signal.aborted) throw new Error("GATE_TIMEOUT");
      const part = await reader.read();
      if (signal.aborted) throw new Error("GATE_TIMEOUT");
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_CONTROL_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("GATE_RESPONSE_TOO_LARGE");
      }
      chunks.push(part.value);
    }
    const body = new Uint8Array(length);
    let offset = 0;
    for (const part of chunks) {
      body.set(part, offset);
      offset += part.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    } catch {
      throw new Error("GATE_RESPONSE_INVALID");
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await cancellation;
    reader.releaseLock();
  }
}
export function createGateClient(options: {
  origin: string;
  environment: BatchEnvironment;
  executorVersion: string;
  keyId: string;
  key: Uint8Array;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}): GateClient {
  let origin: URL;
  try {
    origin = new URL(options.origin);
    environmentSchema.parse(options.environment);
    if (
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      !(
        origin.protocol === "https:" ||
        (origin.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))
      ) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(options.executorVersion) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(options.keyId) ||
      options.key.byteLength < 32 ||
      (options.timeoutMs !== undefined &&
        (!Number.isInteger(options.timeoutMs) ||
          options.timeoutMs < 1 ||
          options.timeoutMs > 10000))
    )
      throw new Error("invalid");
  } catch {
    throw new Error("GATE_CONFIG_INVALID");
  }
  const { environment, executorVersion, keyId } = options;
  const key = new Uint8Array(options.key);
  const fetcher = options.fetcher ?? fetch;
  const originUrl = origin.origin;
  const timeoutMs = options.timeoutMs ?? 10000;
  async function send(raw: GateRequest, action: GateRequest["action"], parent: AbortSignal) {
    const parsed = gateRequestSchema.safeParse(raw);
    if (!parsed.success || parsed.data.environment !== environment || parsed.data.action !== action)
      throw new Error("GATE_REQUEST_INVALID");
    const body = new TextEncoder().encode(JSON.stringify(parsed.data));
    if (body.byteLength > MAX_CONTROL_REQUEST_BYTES) throw new Error("GATE_REQUEST_INVALID");
    const controller = new AbortController();
    const signal = AbortSignal.any([parent, controller.signal]);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response | undefined;
    try {
      if (signal.aborted) throw new Error("GATE_TIMEOUT");
      const url = new URL(`/v1/gate/${action}`, originUrl).toString();
      const now = Date.now();
      const headers = await signRequest(
        { method: "POST", url, body },
        {
          authVersion: "v1",
          direction: "node-to-cf",
          environment: environment,
          executorVersion: executorVersion,
          keyId: keyId,
          requestId: crypto.randomUUID(),
          nonce: crypto.randomUUID(),
          issuedAt: now,
          expiresAt: now + 60000,
        },
        key,
      );
      headers.set("content-type", "application/json");
      headers.set("accept", "application/json");
      if (signal.aborted) throw new Error("GATE_TIMEOUT");
      response = await fetcher(url, {
        method: "POST",
        body,
        headers,
        signal,
        redirect: "manual",
        credentials: "omit",
      });
      if (signal.aborted) throw new Error("GATE_TIMEOUT");
      if (response.status !== 200) throw new Error("GATE_HTTP_FAILED");
      const value = await readBounded(response, signal);
      const schema =
        action === "reserve"
          ? gateReserveResponseSchema
          : action === "consume"
            ? gateConsumeResponseSchema
            : gateReportResponseSchema;
      const output = schema.safeParse(value);
      if (!output.success) throw new Error("GATE_RESPONSE_INVALID");
      return output.data;
    } catch (error) {
      if (response?.body && !response.body.locked)
        await response.body.cancel().catch(() => undefined);
      if (signal.aborted) throw new Error("GATE_TIMEOUT");
      if (
        error instanceof Error &&
        ["GATE_HTTP_FAILED", "GATE_RESPONSE_TOO_LARGE", "GATE_RESPONSE_INVALID"].includes(
          error.message,
        )
      )
        throw error;
      throw new Error("GATE_TRANSPORT_FAILED");
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    reserve: async (input, signal) => (await send(input, "reserve", signal)) as GateReserveResponse,
    consume: async (input, signal) => (await send(input, "consume", signal)) as GateConsumeResponse,
    report: async (input, signal) =>
      (await send(input, "report", signal)) as { status: "reported" },
  };
}
