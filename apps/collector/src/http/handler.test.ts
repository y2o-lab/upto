import { signRequest } from "@upto/domain/batch";
import { describe, expect, it } from "vitest";

import type { BatchObserver, BatchLogRecord } from "../observability.js";

import { createCollectorHandler, type CollectorHttpServices } from "./handler.js";

const key = new TextEncoder().encode("fixture-auth-material-not-a-real-secret-0001");
const id = "00000000-0000-4000-8000-000000000001";
const base = {
  apiVersion: "v1",
  environment: "staging",
  stage: "extract",
  jobId: id,
  workId: id,
  operationKey: "a".repeat(64),
  executorVersion: "fixture",
  configVersion: "1",
  deadlineAt: new Date(Date.now() + 60000).toISOString(),
  candidateId: id,
  generationId: id,
};
const success = {
  status: "succeeded" as const,
  stage: "extract" as const,
  contentId: id,
  chunkManifestId: id,
  chunkCount: 1,
  inputHash: "a".repeat(64),
};
function services(): CollectorHttpServices {
  return {
    replay: async () => null,
    execute: async () => success,
    manifests: async (query) => ({ manifestId: query.manifestId, entries: [], nextCursor: null }),
    operationStatus: async () => ({ status: "not_found" }),
  };
}
function handler(
  service = services(),
  timeoutMs = 240000,
  logger?: (record: { errorCode: string; requestId: string }) => void,
) {
  return createCollectorHandler({
    environment: "staging",
    executorVersions: ["fixture"],
    configVersions: ["1"],
    keys: new Map([["fixture", key]]),
    consumeNonce: async () => true,
    services: service,
    timeoutMs,
    ...(logger ? { logger } : {}),
  });
}
async function request(body: unknown = base, path = "/api/v1/extract", method = "POST") {
  const bytes = new TextEncoder().encode(method === "GET" ? "" : JSON.stringify(body));
  const url = "https://fixture.example" + path;
  const now = Date.now();
  const headers = await signRequest(
    { method, url, body: bytes },
    {
      authVersion: "v1",
      direction: "cf-to-node",
      environment: "staging",
      keyId: "fixture",
      executorVersion: "fixture",
      requestId: crypto.randomUUID(),
      nonce: crypto.randomUUID(),
      issuedAt: now,
      expiresAt: now + 60000,
    },
    key,
  );
  headers.set("content-type", "application/json");
  return new Request(url, { method, headers, ...(method === "GET" ? {} : { body: bytes }) });
}
describe("collector HTTP boundary", () => {
  it("authenticates and validates the request and success response", async () => {
    const response = await handler()(await request());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(success);
    expect(response.headers.get("x-upto-request-id")).toMatch(/^[a-f0-9-]{36}$/);
  });
  it("rejects cross-stage, environment, config and extra fields without executing", async () => {
    let executions = 0;
    const service = {
      ...services(),
      execute: async () => {
        executions++;
        return success;
      },
    };
    for (const changed of [
      { environment: "production" },
      { configVersion: "unknown" },
      { stage: "persist" },
      { prompt: "private" },
      { executorVersion: "other" },
    ]) {
      const response = await handler(service)(await request({ ...base, ...changed }));
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
    }
    expect(executions).toBe(0);
  });
  it("recovers cached success after deadline but refuses fresh execution", async () => {
    const expired = { ...base, deadlineAt: new Date(0).toISOString() };
    expect((await handler()(await request(expired))).status).toBe(408);
    const cached = {
      ...services(),
      replay: async () => success,
      execute: async () => {
        throw new Error("must not execute");
      },
    };
    expect(await (await handler(cached)(await request(expired))).json()).toEqual(success);
  });
  it("refuses duplicate query fields, unknown fields and noncanonical integers", async () => {
    const queries = [
      "apiVersion=v1&environment=staging&manifestId=" + id + "&limit=1&limit=2",
      "apiVersion=v1&environment=staging&manifestId=" + id + "&limit=1&extra=private",
      "apiVersion=v1&environment=staging&manifestId=" + id + "&limit=01",
    ];
    for (const query of queries)
      expect(
        (await handler()(await request(null, "/api/v1/manifests?" + query, "GET"))).status,
      ).toBe(400);
  });
  it("returns sanitized errors and logs only safe codes and request IDs", async () => {
    const records: unknown[] = [];
    const service = {
      ...services(),
      execute: async () => {
        throw new Error("private-token-body-prompt");
      },
    };
    const response = await handler(service, 240000, (record) => records.push(record))(
      await request(),
    );
    expect(response.status).toBe(503);
    const data = JSON.stringify(await response.json()) + JSON.stringify(records);
    expect(data).not.toContain("private-token-body-prompt");
    expect(data).toContain("EXECUTOR_FAILURE");
  });
  it("rejects invalid response fields instead of exposing payloads", async () => {
    const service = { ...services(), execute: async () => ({ ...success, prompt: "private" }) };
    const response = await handler(service)(await request());
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("private");
  });
  it("aborts expired execution and awaits its settlement before responding", async () => {
    let settled = false;
    const service: CollectorHttpServices = {
      ...services(),
      execute: async (_request, context) => {
        await new Promise<void>((resolve) =>
          context.signal.addEventListener(
            "abort",
            () => {
              settled = true;
              resolve();
            },
            { once: true },
          ),
        );
        return success;
      },
    };
    const response = await handler(service, 100)(await request());
    expect(response.status).toBe(408);
    expect(settled).toBe(true);
  });
  it("fails startup without an executable configuration", () => {
    expect(() =>
      createCollectorHandler({
        environment: "staging",
        executorVersions: ["fixture"],
        configVersions: [],
        keys: new Map([["fixture", key]]),
        consumeNonce: async () => true,
        services: services(),
      }),
    ).toThrow("HTTP_CONFIGURATION_INVALID");
  });
});
it("prepares an authorized operation key without exposing prompt or executing the stage", async () => {
  const service = services();
  let executed = false;
  service.execute = async () => {
    executed = true;
    return success;
  };
  service.prepare = async (input) => ({
    apiVersion: "v1",
    stage: input.stage,
    operationKey: "a".repeat(64),
    inputHash: "b".repeat(64),
    generationId: id,
  });
  const { operationKey: _key, ...input } = base;
  const response = await handler(service)(await request(input, "/api/v1/prepare"));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    operationKey: "a".repeat(64),
    inputHash: "b".repeat(64),
  });
  expect(executed).toBe(false);
});
it("rejects expired prepare requests before input binding", async () => {
  const service = services();
  let calls = 0;
  service.prepare = async (input) => {
    calls++;
    return {
      apiVersion: "v1",
      stage: input.stage,
      operationKey: "a".repeat(64),
      inputHash: "b".repeat(64),
      generationId: id,
    };
  };
  const { operationKey: _key, ...input } = base;
  const response = await handler(service)(
    await request({ ...input, deadlineAt: new Date(0).toISOString() }, "/api/v1/prepare"),
  );
  expect(response.status).toBe(408);
  expect(calls).toBe(0);
});
it("aborts prepare at the caller deadline and waits for settlement", async () => {
  const service = services();
  let settled = false;
  let overrun = Infinity;
  service.prepare = async (input, context) => {
    await new Promise<void>((resolve) => {
      context.signal.addEventListener(
        "abort",
        () => {
          overrun = Date.now() - context.deadlineAt;
          settled = true;
          resolve();
        },
        { once: true },
      );
    });
    return {
      apiVersion: "v1",
      stage: input.stage,
      operationKey: "a".repeat(64),
      inputHash: "b".repeat(64),
      generationId: id,
    };
  };
  const { operationKey: _key, ...input } = base;
  const response = await handler(
    service,
    1000,
  )(
    await request(
      { ...input, deadlineAt: new Date(Date.now() + 100).toISOString() },
      "/api/v1/prepare",
    ),
  );
  expect(response.status).toBe(408);
  expect(settled).toBe(true);
  expect(overrun).toBeLessThan(250);
});
it("does not expose private material returned by an invalid prepare implementation", async () => {
  const service = services();
  service.prepare = async (input) => ({
    apiVersion: "v1",
    stage: input.stage,
    operationKey: "a".repeat(64),
    inputHash: "b".repeat(64),
    generationId: id,
    prompt: "fixture-private-prompt",
  });
  const { operationKey: _key, ...input } = base;
  const response = await handler(service)(await request(input, "/api/v1/prepare"));
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("fixture-private-prompt");
});

describe("batch observability", () => {
  function observed(service: CollectorHttpServices, observer: BatchObserver) {
    return createCollectorHandler({
      environment: "staging",
      executorVersions: ["fixture"],
      configVersions: ["1"],
      keys: new Map([["fixture", key]]),
      consumeNonce: async () => true,
      services: service,
      observer,
    });
  }
  it.each([false, true])("records safe correlation and replay=%s", async (replay) => {
    const records: BatchLogRecord[] = [];
    const service = { ...services(), replay: async () => (replay ? success : null) };
    const response = await observed(service, async (event) => {
      records.push(event);
    })(await request());
    expect(response.status).toBe(200);
    expect(records.map((event) => event.event)).toEqual(["stage_started", "stage_finished"]);
    expect(records[1]).toMatchObject({
      jobId: id,
      workId: id,
      generationId: id,
      operationKey: base.operationKey,
      stage: "extract",
      status: "succeeded",
      replay,
      durationMs: expect.any(Number),
    });
    expect(records[1]?.requestId).toBe(response.headers.get("x-upto-request-id"));
  });
  it.each([
    { status: "failed" as const, errorCode: "GENERATION_OUTCOME_UNKNOWN", retryable: false },
    {
      status: "waiting" as const,
      reason: "GATE_UNAVAILABLE",
      nextEligibleAt: new Date(Date.now() + 60000).toISOString(),
    },
  ])("records business failure/wait even with HTTP 200", async (result) => {
    const records: BatchLogRecord[] = [];
    const service = { ...services(), execute: async () => result };
    expect(
      (
        await observed(service, async (event) => {
          records.push(event);
        })(await request())
      ).status,
    ).toBe(200);
    expect(records[1]).toMatchObject({
      status: result.status,
      errorCode: "errorCode" in result ? result.errorCode : result.reason,
    });
  });
  it("records errors after correlation and contains observer errors", async () => {
    const records: BatchLogRecord[] = [];
    const service = {
      ...services(),
      execute: async (): Promise<never> => {
        throw new Error("private-database-url");
      },
    };
    const response = await observed(service, async (event) => {
      records.push(event);
      throw new Error("private-observer-error");
    })(await request());
    expect(response.status).toBe(503);
    expect(records[1]).toMatchObject({
      event: "request_failed",
      jobId: id,
      operationKey: base.operationKey,
      errorCode: "EXECUTOR_FAILURE",
      httpStatus: 503,
    });
    expect(JSON.stringify(records)).not.toContain("private");
  });
  it("reports failed/cancelled counts even when finalization succeeds", async () => {
    const records: BatchLogRecord[] = [];
    const input = {
      ...base,
      stage: "job-finalize",
      candidateId: undefined,
      generationId: undefined,
      countVersion: 1,
      counts: { fetched: 3, succeeded: 1, failed: 1, cancelled: 1 },
    };
    const service = {
      ...services(),
      execute: async () => ({
        status: "succeeded" as const,
        stage: "job-finalize" as const,
        crawlJobId: id,
        countVersion: 1,
      }),
    };
    expect(
      (
        await observed(service, async (event) => {
          records.push(event);
        })(await request(input, "/api/v1/job-finalize"))
      ).status,
    ).toBe(200);
    expect(records[1]).toMatchObject({ failedCount: 1, cancelledCount: 1 });
  });
});
it("classifies a wrapped PG cause without logging queries or parameters", async () => {
  const records: BatchLogRecord[] = [];
  const service = {
    ...services(),
    execute: async (): Promise<never> => {
      throw new Error("private-query", { cause: { code: "57014", detail: "private-parameters" } });
    },
  };
  const run = createCollectorHandler({
    environment: "staging",
    executorVersions: ["fixture"],
    configVersions: ["1"],
    keys: new Map([["fixture", key]]),
    consumeNonce: async () => true,
    services: service,
    observer: async (record) => {
      records.push(record);
    },
  });
  expect((await run(await request())).status).toBe(503);
  expect(records[1]).toMatchObject({ causeCode: "DATABASE_STATEMENT_TIMEOUT" });
  expect(JSON.stringify(records)).not.toContain("private");
});
