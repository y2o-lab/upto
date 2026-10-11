import { operationKey, signRequest, type StageRequest } from "@upto/domain/batch";
import { beforeAll, afterAll, beforeEach, expect, it } from "vitest";

import type { HttpExecutionContext } from "../../../apps/collector/src/http/handler.js";

import { createCollectorHandler } from "../../../apps/collector/src/http/handler.js";
import { createRepositoryHttpServices } from "../../../apps/collector/src/http/repositories.js";
import { createExtractStage } from "../../../apps/collector/src/stages/extract.js";
import { NonceRepository } from "../src/collector/nonces.js";
import { createIntegrationDatabase } from "./database.js";
let database: Awaited<ReturnType<typeof createIntegrationDatabase>>;
let request: Extract<StageRequest, { stage: "extract" }>;
const cursorKey = new TextEncoder().encode("fixture-cursor-material-not-a-secret-0001");
function execution(): HttpExecutionContext {
  const now = Date.now();
  return {
    auth: {
      authVersion: "v1",
      environment: "staging",
      direction: "cf-to-node",
      requestId: crypto.randomUUID(),
      nonce: crypto.randomUUID(),
      issuedAt: now,
      expiresAt: now + 60000,
      keyId: "fixture",
      executorVersion: "1",
    },
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 60000,
    assertTimeLeft() {},
  };
}
beforeAll(async () => {
  database = await createIntegrationDatabase();
});
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  await database.pool.query("TRUNCATE sources CASCADE");
  const source = (
    await database.pool.query(
      "INSERT INTO sources(name,site_url) VALUES ('fixture','https://fixture.example') RETURNING id",
    )
  ).rows[0].id;
  const article = (
    await database.pool.query(
      "INSERT INTO articles(source_id,title,original_url,normalized_url) VALUES ($1,'架空記事','https://fixture.example/article','https://fixture.example/article') RETURNING id",
      [source],
    )
  ).rows[0].id;
  const generation = (
    await database.pool.query(
      "INSERT INTO collector_generations(environment,article_id,prompt_version,schema_version,config_version) VALUES ('staging',$1,'1','1','1') RETURNING id",
      [article],
    )
  ).rows[0].id;
  const jobId = crypto.randomUUID();
  const discovery = (
    await database.pool.query(
      "INSERT INTO collector_discoveries(environment,job_id,feed_id,scheduled_at,executor_version,config_version,manifest_hash) VALUES ('staging',$1,'fixture',now(),'1','1',$2) RETURNING id",
      [jobId, "a".repeat(64)],
    )
  ).rows[0].id;
  const candidate = (
    await database.pool.query(
      "INSERT INTO collector_candidates(discovery_id,normalized_url,article_id,disposition,metadata) VALUES ($1,'https://fixture.example/article',$2,'process',$3) RETURNING id",
      [discovery, article, JSON.stringify({ summaryText: "架空の短文", contentHtml: null })],
    )
  ).rows[0].id;
  request = {
    apiVersion: "v1",
    environment: "staging",
    stage: "extract",
    jobId,
    workId: crypto.randomUUID(),
    operationKey: "a".repeat(64),
    executorVersion: "1",
    configVersion: "1",
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
    candidateId: candidate,
    generationId: generation,
  };
});
function stage(fetcher: typeof fetch) {
  return createExtractStage({
    db: database.db,
    cursorKey,
    chunkChars: 1000,
    chunkerVersion: "1",
    fetcher,
  });
}
async function prepared(value: ReturnType<typeof stage>) {
  request.operationKey = await operationKey((await value.resolve(request)).identity);
}
it("stores extracted chunks and replays without refetch after commit", async () => {
  let calls = 0;
  const text = "架空の技術本文。".repeat(300);
  const value = stage(async (_input, init) => {
    calls++;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return new Response(`<article><p>${text}</p></article>`);
  });
  await prepared(value);
  const result = await value.execute(request, execution());
  expect(result).toMatchObject({ status: "succeeded", stage: "extract", chunkCount: 3 });
  const services = createRepositoryHttpServices({ db: database.db, cursorKey, ...value });
  expect(await services.replay(request, execution())).toEqual(result);
  expect(await value.execute(request, execution())).toEqual(result);
  expect(calls).toBe(1);
  expect(
    (await database.pool.query("SELECT count(*)::int AS n FROM collector_payloads")).rows[0].n,
  ).toBe(1);
  expect(
    (await database.pool.query("SELECT count(*)::int AS n FROM collector_chunks")).rows[0].n,
  ).toBe(3);
});
it("authorizes candidate/job/environment/version before fetching or binding input", async () => {
  let calls = 0;
  const value = stage(async () => {
    calls++;
    return new Response("");
  });
  for (const changed of [
    { jobId: crypto.randomUUID() },
    { environment: "production" as const },
    { configVersion: "2" },
    { candidateId: crypto.randomUUID() },
  ])
    await expect(value.resolve({ ...request, ...changed })).rejects.toThrow(
      "EXTRACTION_REFERENCE_MISMATCH",
    );
  expect(calls).toBe(0);
  expect(
    (await database.pool.query("SELECT count(*)::int AS n FROM collector_extraction_inputs"))
      .rows[0].n,
  ).toBe(0);
});
it("rejects a candidate bound to another generation before freezing extraction input", async () => {
  await database.pool.query(
    "UPDATE collector_candidates SET metadata=metadata || jsonb_build_object('generationId',$1::text)",
    [crypto.randomUUID()],
  );
  await expect(
    stage(async () => {
      throw new Error("must not fetch");
    }).resolve(request),
  ).rejects.toThrow("EXTRACTION_REFERENCE_MISMATCH");
  expect(
    (await database.pool.query("SELECT count(*)::int AS n FROM collector_extraction_inputs"))
      .rows[0].n,
  ).toBe(0);
});
it("joins different authorized candidates onto one immutable extraction input", async () => {
  const value = stage(async () => new Response(""));
  await prepared(value);
  const original = await value.resolve(request);
  await database.pool.query("UPDATE collector_candidates SET metadata=$1", [
    JSON.stringify({ summaryText: "別の架空fallback", contentHtml: null }),
  ]);
  const other = stage(async () => new Response(""));
  const jobId = crypto.randomUUID();
  const discovery = (
    await database.pool.query(
      "INSERT INTO collector_discoveries(environment,job_id,feed_id,scheduled_at,executor_version,config_version,manifest_hash) VALUES ('staging',$1,'other-feed',now(),'1','1',$2) RETURNING id",
      [jobId, "a".repeat(64)],
    )
  ).rows[0].id;
  const candidateId = (
    await database.pool.query(
      "INSERT INTO collector_candidates(discovery_id,normalized_url,article_id,disposition,metadata) SELECT $1, normalized_url, article_id, disposition, metadata FROM collector_candidates WHERE id=$2 RETURNING id",
      [discovery, request.candidateId],
    )
  ).rows[0].id;
  const joinedRequest = { ...request, jobId, candidateId };
  expect(await other.resolve(joinedRequest)).toEqual(original);
  expect(await value.execute(request, execution())).toMatchObject({
    status: "succeeded",
    chunkCount: 1,
  });
  expect(
    (await database.pool.query("SELECT content_text FROM collector_payloads")).rows[0].content_text,
  ).toBe("架空の短文");
  expect(await other.execute(joinedRequest, execution())).toMatchObject({
    status: "succeeded",
    chunkCount: 1,
  });
});
it("records an empty extraction failure with no payload or chunks", async () => {
  await database.pool.query("UPDATE collector_candidates SET metadata=$1", [
    JSON.stringify({ summaryText: "", contentHtml: null }),
  ]);
  const value = stage(async () => new Response("<html></html>"));
  await prepared(value);
  expect(await value.execute(request, execution())).toEqual({
    status: "failed",
    errorCode: "EXTRACTION_EMPTY",
    retryable: false,
  });
  expect(
    (await database.pool.query("SELECT count(*)::int AS n FROM collector_payloads")).rows[0].n,
  ).toBe(0);
  expect(
    (await database.pool.query("SELECT status FROM collector_operations")).rows[0].status,
  ).toBe("failed");
});

it("runs signed HTTP extraction and authorizes expired replay before returning success", async () => {
  let calls = 0;
  const value = stage(async () => {
    calls++;
    return new Response("");
  });
  await prepared(value);
  const services = createRepositoryHttpServices({ db: database.db, cursorKey, ...value });
  const key = new TextEncoder().encode("fixture-auth-material-not-a-secret-0001");
  const handler = createCollectorHandler({
    environment: "staging",
    executorVersions: ["1"],
    configVersions: ["1"],
    keys: new Map([["fixture", key]]),
    consumeNonce: (input) => new NonceRepository(database.db).consume(input),
    services,
  });
  async function send(input: typeof request) {
    const body = new TextEncoder().encode(JSON.stringify(input));
    const url = "https://fixture.example/api/v1/extract";
    const headers = await signRequest({ method: "POST", url, body }, execution().auth, key);
    headers.set("content-type", "application/json");
    return handler(new Request(url, { method: "POST", body, headers }));
  }
  expect(
    (
      await send({
        ...request,
        deadlineAt: new Date(0).toISOString(),
        operationKey: "f".repeat(64),
      })
    ).status,
  ).toBe(408);
  // prepare above froze the valid input; a genuinely new request must not freeze one.
  await database.pool.query("DELETE FROM collector_extraction_inputs");
  expect((await send({ ...request, deadlineAt: new Date(0).toISOString() })).status).toBe(408);
  expect(
    (await database.pool.query("SELECT count(*)::int AS n FROM collector_extraction_inputs"))
      .rows[0].n,
  ).toBe(0);
  const first = await send(request);
  expect(first.status).toBe(200);
  const saved = await first.json();
  expect(saved).toMatchObject({ status: "succeeded", stage: "extract" });
  expect(await (await send({ ...request, deadlineAt: new Date(0).toISOString() })).json()).toEqual(
    saved,
  );
  expect((await send({ ...request, jobId: crypto.randomUUID() })).status).toBe(409);
  expect(calls).toBe(1);
});

it("fences simultaneous extraction and refuses altered keys before fetching", async () => {
  let calls = 0;
  let started!: () => void;
  let finish!: () => void;
  const start = new Promise<void>((resolve) => {
    started = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const value = stage(async () => {
    calls++;
    started();
    await gate;
    return new Response("");
  });
  await prepared(value);
  await expect(
    value.execute({ ...request, operationKey: "b".repeat(64) }, execution()),
  ).rejects.toThrow("OPERATION_INPUT_CONFLICT");
  expect(calls).toBe(0);
  const first = value.execute(request, execution());
  await start;
  try {
    expect(await value.execute(request, execution())).toMatchObject({ status: "running" });
    expect(calls).toBe(1);
  } finally {
    finish();
  }
  expect(await first).toMatchObject({ status: "succeeded" });
  expect(
    (await database.pool.query("SELECT count(*)::int AS n FROM collector_operations")).rows[0].n,
  ).toBe(1);
});

it("does not commit fallback when the invocation is aborted", async () => {
  const controller = new AbortController();
  const value = stage(async (_input, init) => {
    expect(init?.signal).toBe(controller.signal);
    controller.abort();
    throw new Error("fixture-abort");
  });
  await prepared(value);
  await expect(
    value.execute(request, { ...execution(), signal: controller.signal }),
  ).rejects.toThrow("REQUEST_DEADLINE_EXCEEDED");
  expect(
    (await database.pool.query("SELECT count(*)::int AS n FROM collector_payloads")).rows[0].n,
  ).toBe(0);
});

it("rejects content beyond the chunk limit before storing any partial snapshot", async () => {
  await database.pool.query("UPDATE collector_candidates SET metadata=$1", [
    JSON.stringify({ summaryText: "架".repeat(65000), contentHtml: null }),
  ]);
  let calls = 0;
  const value = stage(async () => {
    calls++;
    return new Response("");
  });
  await prepared(value);
  expect(await value.execute(request, execution())).toEqual({
    status: "failed",
    errorCode: "EXTRACTION_LIMIT_EXCEEDED",
    retryable: false,
  });
  expect(calls).toBe(0);
  expect(
    (await database.pool.query("SELECT count(*)::int AS n FROM collector_chunks")).rows[0].n,
  ).toBe(0);
  expect(
    (await database.pool.query("SELECT count(*)::int AS n FROM collector_results")).rows[0].n,
  ).toBe(0);
});

it("detects frozen input corruption and version changes before executing", async () => {
  const value = stage(async () => {
    throw new Error("must not fetch");
  });
  await prepared(value);
  const changed = createExtractStage({
    db: database.db,
    cursorKey,
    chunkChars: 2000,
    chunkerVersion: "2",
  });
  await expect(changed.resolve(request)).rejects.toThrow("GENERATION_VERSION_CONFLICT");
  await database.pool.query("UPDATE collector_extraction_inputs SET input_hash=$1", [
    "b".repeat(64),
  ]);
  await expect(value.execute(request, execution())).rejects.toThrow(
    "EXTRACTION_INPUT_INTEGRITY_MISMATCH",
  );
});
