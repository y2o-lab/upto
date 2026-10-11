import { operationKey, signRequest, type StageRequest } from "@upto/domain/batch";
import { createHash } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it } from "vitest";

import { createCollectorHandler } from "../../../apps/collector/src/http/handler.js";
import { createCollectorServer } from "../../../apps/collector/src/http/node-adapter.js";
import {
  createRepositoryHttpServices,
  type ResolvedOperation,
} from "../../../apps/collector/src/http/repositories.js";
import {
  GenerationRepository,
  OperationRepository,
  PayloadRepository,
  NonceRepository,
} from "../src/collector/index.js";
import { createIntegrationDatabase } from "./database.js";

let context: Awaited<ReturnType<typeof createIntegrationDatabase>>;
let server: ReturnType<typeof createCollectorServer>;
let origin = "";
let generationId = "";
let candidateId = crypto.randomUUID();
let keyValue = "";
let responseId = "";
let executions = 0;
const key = new TextEncoder().encode("fixture-http-key-material-never-real-0001");
const cursorKey = new TextEncoder().encode("fixture-cursor-key-material-never-real-0001");
function resolved(request: StageRequest): ResolvedOperation {
  if (request.stage !== "extract") throw new Error("fixture unsupported stage");
  const inputHash = createHash("sha256")
    .update(JSON.stringify([request.candidateId, request.generationId]))
    .digest("hex");
  return {
    identity: {
      environment: request.environment,
      stage: request.stage,
      logicalEntityId: request.generationId,
      inputHash,
      model: "",
      promptVersion: "1",
      schemaVersion: "1",
    },
    generationId: request.generationId,
  };
}
function body() {
  return {
    apiVersion: "v1" as const,
    environment: "staging" as const,
    stage: "extract" as const,
    jobId: crypto.randomUUID(),
    workId: crypto.randomUUID(),
    operationKey: keyValue,
    executorVersion: "fixture-build",
    configVersion: "1",
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
    candidateId,
    generationId,
  };
}
async function signedRequest(path: string, value?: unknown) {
  const method = value === undefined ? "GET" : "POST";
  const bytes = new TextEncoder().encode(value === undefined ? "" : JSON.stringify(value));
  const url = origin + path;
  const now = Date.now();
  const headers = await signRequest(
    { method, url, body: bytes },
    {
      authVersion: "v1",
      direction: "cf-to-node",
      environment: "staging",
      keyId: "fixture",
      executorVersion: "fixture-build",
      requestId: crypto.randomUUID(),
      nonce: crypto.randomUUID(),
      issuedAt: now,
      expiresAt: now + 60000,
    },
    key,
  );
  headers.set("content-type", "application/json");
  return { method, url, headers, bytes };
}
async function send(input: Awaited<ReturnType<typeof signedRequest>>, bytes = input.bytes) {
  return fetch(input.url, {
    method: input.method,
    headers: input.headers,
    ...(input.method === "GET" ? {} : { body: bytes }),
  });
}
beforeAll(async () => {
  context = await createIntegrationDatabase();
  const source = await context.pool.query(
    "INSERT INTO sources(name,site_url) VALUES ('fixture','https://fixture.example') RETURNING id",
  );
  const article = await context.pool.query(
    "INSERT INTO articles(source_id,title,original_url,normalized_url) VALUES ($1,'架空記事','https://fixture.example/http','https://fixture.example/http') RETURNING id",
    [source.rows[0].id],
  );
  const generation = await new GenerationRepository(context.db).join({
    articleId: article.rows[0].id,
    environment: "staging",
    configVersion: "1",
    promptVersion: "1",
    schemaVersion: "1",
  });
  if (generation.status !== "joined") throw new Error("Expected generation");
  generationId = generation.generationId;
  keyValue = await operationKey(resolved(body()).identity);
  const services = createRepositoryHttpServices({
    db: context.db,
    cursorKey,
    resolve: async (request) => resolved(request),
    execute: async (request, execution) => {
      executions++;
      execution.assertTimeLeft();
      if (request.stage !== "extract") throw new Error("fixture unsupported stage");
      const identity = resolved(request);
      const claim = await new OperationRepository(context.db).claim({
        ...identity.identity,
        operationKey: request.operationKey,
        owner: execution.auth.requestId,
        leaseMs: 360000,
        generationId,
      });
      if (claim.status !== "claimed") throw new Error("fixture unexpected claim");
      return new PayloadRepository(context.db, cursorKey).saveExtraction(claim.fence, {
        generationId,
        contentText: "架空本文",
        contentHtml: "<p>架空本文</p>",
        extractionStatus: "extracted",
        chunkerVersion: "1",
        chunks: ["架空", "本文"],
      });
    },
  });
  const handler = createCollectorHandler({
    environment: "staging",
    executorVersions: ["fixture-build"],
    configVersions: ["1"],
    keys: new Map([["fixture", key]]),
    consumeNonce: (input) => new NonceRepository(context.db).consume(input),
    services,
  });
  server = createCollectorServer(handler, () => origin);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected local address");
  origin = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  await context?.close();
});

describe("real Node HTTP adapter with HMAC and PostgreSQL", () => {
  it("commits an extraction and recovers the same references after response loss and expired deadline", async () => {
    const request = await signedRequest("/api/v1/extract", body());
    const first = await send(request);
    expect(first.status).toBe(200);
    const saved = await first.json();
    responseId = saved.chunkManifestId;
    const retry = await send(
      await signedRequest("/api/v1/extract", { ...body(), deadlineAt: new Date(0).toISOString() }),
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(saved);
    expect(executions).toBe(1);
    const counts = await context.pool.query(
      "SELECT (SELECT count(*)::int FROM collector_payloads) AS payloads,(SELECT count(*)::int FROM collector_chunks) AS chunks,(SELECT count(*)::int FROM collector_results) AS results",
    );
    expect(counts.rows[0]).toEqual({ payloads: 1, chunks: 2, results: 1 });
  });
  it("reads saved manifest/status through signed query requests", async () => {
    const manifest = await send(
      await signedRequest(
        `/api/v1/manifests?apiVersion=v1&environment=staging&manifestId=${responseId}&limit=1`,
      ),
    );
    expect(manifest.status).toBe(200);
    const first = await manifest.json();
    expect(first.entries).toHaveLength(1);
    expect(first.nextCursor).toBeTypeOf("string");
    const status = await send(
      await signedRequest(
        `/api/v1/operation-status?apiVersion=v1&environment=staging&operationKey=${keyValue}`,
      ),
    );
    expect(await status.json()).toMatchObject({ status: "succeeded" });
  });
  it("rejects changed input under a committed key instead of replaying an unrelated result", async () => {
    const response = await send(
      await signedRequest("/api/v1/extract", { ...body(), candidateId: crypto.randomUUID() }),
    );
    expect(response.status).toBe(409);
    expect((await response.json()).errorCode).toBe("OPERATION_INPUT_CONFLICT");
    expect(executions).toBe(1);
  });
  it("rejects raw body tampering without writing a nonce or running a stage", async () => {
    const request = await signedRequest("/api/v1/extract", body());
    const changed = new TextEncoder().encode(new TextDecoder().decode(request.bytes) + " ");
    const response = await send(request, changed);
    expect(response.status).toBe(401);
    expect(executions).toBe(1);
  });
  it("rejects oversized raw body before nonce persistence or stage execution", async () => {
    const request = await signedRequest("/api/v1/extract", body());
    const response = await send(request, new Uint8Array(16385));
    expect(response.status).toBe(413);
    expect((await response.json()).errorCode).toBe("REQUEST_BODY_TOO_LARGE");
    expect(
      (
        await context.pool.query(
          "SELECT count(*)::int AS count FROM collector_auth_nonces WHERE nonce=$1",
          [request.headers.get("x-upto-nonce")],
        )
      ).rows[0].count,
    ).toBe(0);
    expect(executions).toBe(1);
  });
  it("rejects tampered query values and ambiguous duplicate fields over HTTP", async () => {
    const request = await signedRequest(
      `/api/v1/manifests?apiVersion=v1&environment=staging&manifestId=${responseId}&limit=1`,
    );
    const changed = { ...request, url: request.url.replace("limit=1", "limit=2") };
    expect((await send(changed)).status).toBe(401);
    const duplicate = await send(
      await signedRequest(
        `/api/v1/manifests?apiVersion=v1&environment=staging&manifestId=${responseId}&limit=1&limit=2`,
      ),
    );
    expect(duplicate.status).toBe(400);
    expect(executions).toBe(1);
  });
  it("rejects simultaneous replay using real HTTP invocations and PG nonce uniqueness", async () => {
    const request = await signedRequest("/api/v1/extract", body());
    const results = await Promise.all([send(request), send(request)]);
    expect(results.map((value) => value.status).sort()).toEqual([200, 401]);
    expect(executions).toBe(1);
  });
});
