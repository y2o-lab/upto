import { GoogleGenAI } from "@google/genai";
import {
  createAuthenticator,
  signRequest,
  gateRequestSchema,
  prepareResponseSchema,
  stageResponseSchema,
  manifestResponseSchema,
} from "@upto/domain/batch";
import { beforeAll, afterAll, expect, it } from "vitest";

import { createIntegrationDatabase } from "../../../packages/db/integration/database.js";
import { createGateClient } from "../src/http/gate-client.js";
import { createCollectorServer } from "../src/http/node-adapter.js";
import { createNodeRuntime } from "../src/http/runtime.js";
import { createGeminiGenerationAdapter } from "../src/stages/gemini-adapter.js";
let database: Awaited<ReturnType<typeof createIntegrationDatabase>>;
let node: ReturnType<typeof createCollectorServer>;
let gate: ReturnType<typeof createCollectorServer>;
let gemini: ReturnType<typeof createCollectorServer>;
let nodeOrigin: string;
let gateOrigin: string;
let geminiOrigin: string;
const nodeKey = new TextEncoder().encode("fixture-node-key-material-not-a-secret-0001");
const gateKey = new TextEncoder().encode("fixture-gate-key-material-not-a-secret-0001");
const cursorKey = new TextEncoder().encode("fixture-cursor-material-not-a-secret-0001");
let generates = 0;
let tokenCounts = 0;
let fetches = 0;
const gateNonces = new Set<string>();
const permits = new Set<string>();
const consumed = new Set<string>();
const summary = {
  title: "架空統合要約",
  difficulty: "beginner",
  importanceScore: 40,
  keyPoints: ["架空ポイント"],
  oneLineSummary: "架空短文",
  summary: "架空統合本文",
  tags: [],
  whyItMatters: "架空理由",
};
async function listen(server: ReturnType<typeof createCollectorServer>) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  return `http://127.0.0.1:${address.port}`;
}
beforeAll(async () => {
  database = await createIntegrationDatabase();
  const auth = createAuthenticator({
    environment: "staging",
    direction: "node-to-cf",
    allowedExecutorVersions: ["1"],
    keys: new Map([["fixture", gateKey]]),
    consumeNonce: async (input) => {
      if (gateNonces.has(input.nonce)) return false;
      gateNonces.add(input.nonce);
      return true;
    },
  });
  gate = createCollectorServer(
    async (request) => {
      const body = new Uint8Array(await request.arrayBuffer());
      await auth.verify({
        method: request.method,
        url: request.url,
        body,
        headers: request.headers,
      });
      const input = gateRequestSchema.parse(JSON.parse(new TextDecoder().decode(body)));
      if (input.action === "reserve") {
        const permitId = crypto.randomUUID();
        permits.add(permitId);
        return Response.json({
          status: "reserved",
          permitId,
          expiresAt: new Date(Date.now() + 5000).toISOString(),
          quotaVersion: "1",
        });
      }
      if (input.action === "consume") {
        if (!permits.has(input.permitId) || consumed.has(input.permitId))
          return new Response(null, { status: 409 });
        consumed.add(input.permitId);
        return Response.json({ status: "consumed", permitId: input.permitId });
      }
      return Response.json({ status: "reported" });
    },
    () => gateOrigin,
  );
  gateOrigin = await listen(gate);
  gemini = createCollectorServer(
    async (request) => {
      const body = await request.json();
      const path = new URL(request.url).pathname;
      if (path.endsWith(":countTokens")) {
        tokenCounts++;
        return Response.json({ totalTokens: 100 });
      }
      generates++;
      const prompt = body.contents[0].parts[0].text as string;
      const output =
        prompt.includes('"parts":') || prompt.includes('"instruction":"本文全体を要約する"')
          ? { kind: "summary", summary }
          : { kind: "chunk", text: `架空部分要約${generates}` };
      return Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: { role: "model", parts: [{ text: JSON.stringify(output) }] },
          },
        ],
        usageMetadata: { promptTokenCount: 100, totalTokenCount: 120, candidatesTokenCount: 20 },
      });
    },
    () => geminiOrigin,
  );
  geminiOrigin = await listen(gemini);
  const adapter = createGeminiGenerationAdapter({
    apiKey: "fixture-dummy-key",
    ai: new GoogleGenAI({ apiKey: "fixture-dummy-key", httpOptions: { baseUrl: geminiOrigin } }),
  });
  const client = createGateClient({
    origin: gateOrigin,
    environment: "staging",
    executorVersion: "1",
    keyId: "fixture",
    key: gateKey,
  });
  const runtime = createNodeRuntime({
    db: database.db,
    config: {
      environment: "staging",
      executorVersion: "1",
      configVersion: "1",
      promptVersion: "1",
      schemaVersion: "1",
      countVersion: "1",
      chunkerVersion: "1",
      primaryModel: "fixture-primary",
      fallbackModel: "fixture-fallback",
      maxOutputTokens: 1000,
      chunkChars: 1000,
      keys: new Map([["fixture", nodeKey]]),
      cursorKey,
      geminiApiKey: "fixture-dummy-key",
      gateOrigin,
      gateKeyId: "fixture",
      gateKey,
    },
    feeds: new Map([
      [
        "fixture",
        {
          kind: "rss",
          name: "fixture",
          siteUrl: "https://fixture.example",
          url: "https://fixture.example/feed",
        },
      ],
      [
        "short",
        {
          kind: "rss",
          name: "short",
          siteUrl: "https://fixture.example",
          url: "https://fixture.example/short-feed",
        },
      ],
    ]),
    dependencies: {
      generation: { ...adapter, gate: client },
      fetcher: async (input) => {
        fetches++;
        if (String(input).endsWith("/short-feed"))
          return new Response(
            `<rss><channel><item><title>架空短文記事</title><link>https://fixture.example/short-article</link><description>${"架空本文。".repeat(180)}</description></item></channel></rss>`,
          );
        return String(input).endsWith("/feed")
          ? new Response(
              "<rss><channel><item><title>架空記事</title><link>https://fixture.example/article</link><description>架空短文</description></item></channel></rss>",
            )
          : new Response(`<article><p>${"架空技術本文。".repeat(300)}</p></article>`);
      },
    },
  });
  node = createCollectorServer(runtime.handler, () => nodeOrigin);
  nodeOrigin = await listen(node);
});
afterAll(async () => {
  for (const server of [node, gate, gemini])
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  await database?.close();
});
async function send(path: string, body?: Record<string, unknown>) {
  const bytes = new TextEncoder().encode(body ? JSON.stringify(body) : "");
  const method = body ? "POST" : "GET";
  const url = nodeOrigin + path;
  const now = Date.now();
  const headers = await signRequest(
    { method, url, body: bytes },
    {
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
    nodeKey,
  );
  headers.set("content-type", "application/json");
  return fetch(url, { method, headers, ...(body ? { body: bytes } : {}) });
}
async function prepared(input: Record<string, unknown>) {
  const response = await send("/api/v1/prepare", input);
  expect(response.status).toBe(200);
  const result = prepareResponseSchema.parse(await response.json());
  return {
    ...input,
    operationKey: result.operationKey,
    ...(result.orderedResultManifestId
      ? { orderedResultManifestId: result.orderedResultManifestId }
      : {}),
  };
}
async function execute(input: Record<string, unknown>) {
  const response = await send(`/api/v1/${input.stage}`, input);
  expect(response.status).toBe(200);
  return stageResponseSchema.parse(await response.json());
}
async function page(manifestId: string) {
  const response = await send(
    `/api/v1/manifests?apiVersion=v1&environment=staging&manifestId=${manifestId}&limit=50`,
  );
  expect(response.status).toBe(200);
  return manifestResponseSchema.parse(await response.json());
}
it("runs every stage through signed HTTP with real PG, actual SDK and signed gate transport", async () => {
  const base = {
    apiVersion: "v1",
    environment: "staging",
    jobId: crypto.randomUUID(),
    workId: crypto.randomUUID(),
    executorVersion: "1",
    configVersion: "1",
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
  };
  const discovery = await execute(
    await prepared({
      ...base,
      stage: "discovery",
      feedId: "fixture",
      scheduledAt: new Date().toISOString(),
      maxItems: 1,
    }),
  );
  if (discovery.status !== "succeeded" || discovery.stage !== "discovery")
    throw new Error("Expected discovery");
  const candidate = (await page(discovery.manifestId)).entries[0];
  if (
    !candidate ||
    !("candidateId" in candidate) ||
    !candidate.generationId ||
    !candidate.feedJobId
  )
    throw new Error("Expected candidate");
  const extracted = await execute(
    await prepared({
      ...base,
      stage: "extract",
      candidateId: candidate.candidateId,
      generationId: candidate.generationId,
    }),
  );
  if (extracted.status !== "succeeded" || extracted.stage !== "extract")
    throw new Error("Expected extraction");
  expect(extracted.chunkCount).toBe(3);
  for (const chunk of (await page(extracted.chunkManifestId)).entries) {
    if (!("chunkId" in chunk)) throw new Error("Expected chunk");
    expect(
      await execute(
        await prepared({
          ...base,
          stage: "summarize-chunk",
          generationId: candidate.generationId,
          chunkId: chunk.chunkId,
          modelTier: "primary",
          apiAttempt: 1,
        }),
      ),
    ).toMatchObject({ status: "succeeded" });
  }
  const mergeRequest = await prepared({
    ...base,
    stage: "merge-summary",
    generationId: candidate.generationId,
    modelTier: "primary",
    apiAttempt: 1,
  });
  const merged = await execute(mergeRequest);
  if (merged.status !== "succeeded" || merged.stage !== "merge-summary")
    throw new Error("Expected merge");
  const persistRequest = await prepared({
    ...base,
    stage: "persist",
    generationId: candidate.generationId,
    finalResultId: merged.finalResultId,
    feedJobId: candidate.feedJobId,
  });
  expect(await execute(persistRequest)).toMatchObject({
    status: "succeeded",
    publication: "published",
  });
  const finalizeRequest = await prepared({
    ...base,
    stage: "job-finalize",
    countVersion: 1,
    counts: { fetched: 1, succeeded: 1, failed: 0, cancelled: 0 },
  });
  expect(await execute(finalizeRequest)).toMatchObject({ status: "succeeded", countVersion: 1 });
  expect(await execute({ ...mergeRequest, deadlineAt: new Date(0).toISOString() })).toEqual(merged);
  expect(await execute({ ...persistRequest, deadlineAt: new Date(0).toISOString() })).toMatchObject(
    { status: "succeeded", publication: "published" },
  );
  expect(generates).toBe(4);
  expect(tokenCounts).toBe(4);
  expect(consumed.size).toBe(4);
  expect(gateNonces.size).toBe(12);
  expect(fetches).toBe(2);
  expect(
    (await database.pool.query("SELECT summary_status FROM articles")).rows[0].summary_status,
  ).toBe("summarized");
  expect(
    (await database.pool.query("SELECT summary_json FROM article_summaries")).rows[0].summary_json
      .one_line_summary,
  ).toBe("架空短文");
  expect(
    (await database.pool.query("SELECT counts FROM collector_job_projections")).rows[0].counts,
  ).toEqual({ fetched: 1, succeeded: 1, failed: 0, cancelled: 0 });
  const bad = await send("/api/v1/prepare", {
    ...base,
    jobId: crypto.randomUUID(),
    stage: "merge-summary",
    generationId: candidate.generationId,
    modelTier: "primary",
    apiAttempt: 1,
  });
  expect(bad.status).toBe(409);
  expect(generates).toBe(4);
});
it("publishes a one-chunk feed fallback with one gated generate and no merge", async () => {
  const beforeGenerate = generates;
  const beforeCount = tokenCounts;
  const beforeFetch = fetches;
  const base = {
    apiVersion: "v1",
    environment: "staging",
    jobId: crypto.randomUUID(),
    workId: crypto.randomUUID(),
    executorVersion: "1",
    configVersion: "1",
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
  };
  const discovery = await execute(
    await prepared({
      ...base,
      stage: "discovery",
      feedId: "short",
      scheduledAt: new Date().toISOString(),
      maxItems: 1,
    }),
  );
  if (discovery.status !== "succeeded" || discovery.stage !== "discovery")
    throw new Error("Expected discovery");
  const candidate = (await page(discovery.manifestId)).entries[0];
  if (
    !candidate ||
    !("candidateId" in candidate) ||
    !candidate.generationId ||
    !candidate.feedJobId
  )
    throw new Error("Expected candidate");
  const extracted = await execute(
    await prepared({
      ...base,
      stage: "extract",
      candidateId: candidate.candidateId,
      generationId: candidate.generationId,
    }),
  );
  if (extracted.status !== "succeeded" || extracted.stage !== "extract")
    throw new Error("Expected extraction");
  expect(extracted.chunkCount).toBe(1);
  const chunk = (await page(extracted.chunkManifestId)).entries[0];
  if (!chunk || !("chunkId" in chunk)) throw new Error("Expected chunk");
  const generated = await execute(
    await prepared({
      ...base,
      stage: "summarize-chunk",
      generationId: candidate.generationId,
      chunkId: chunk.chunkId,
      modelTier: "primary",
      apiAttempt: 1,
    }),
  );
  if (generated.status !== "succeeded" || generated.stage !== "summarize-chunk")
    throw new Error("Expected summary");
  const publication = await prepared({
    ...base,
    stage: "persist",
    generationId: candidate.generationId,
    finalResultId: generated.resultId,
    feedJobId: candidate.feedJobId,
  });
  expect(await execute(publication)).toMatchObject({
    status: "succeeded",
    publication: "published",
  });
  expect(await execute({ ...publication, deadlineAt: new Date(0).toISOString() })).toMatchObject({
    status: "succeeded",
    publication: "published",
  });
  expect(generates - beforeGenerate).toBe(1);
  expect(tokenCounts - beforeCount).toBe(1);
  expect(fetches - beforeFetch).toBe(1);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS n FROM collector_operations WHERE generation_id=$1 AND stage='merge-summary'",
        [candidate.generationId],
      )
    ).rows[0].n,
  ).toBe(0);
});
