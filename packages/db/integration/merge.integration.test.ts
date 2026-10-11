import { operationKey } from "@upto/domain/batch";
import { beforeAll, afterAll, beforeEach, expect, it } from "vitest";

import type { GenerationDependencies } from "../../../apps/collector/src/stages/generation-sender.js";

import { createMergeSummaryStage } from "../../../apps/collector/src/stages/merge-summary.js";
import { createPersistStage } from "../../../apps/collector/src/stages/persist.js";
import { createSummarizeChunkStage } from "../../../apps/collector/src/stages/summarize-chunk.js";
import { PayloadRepository, OperationRepository } from "../src/collector/index.js";
import { MergeInputRepository } from "../src/collector/merge-input.js";
import { createIntegrationDatabase } from "./database.js";
let database: Awaited<ReturnType<typeof createIntegrationDatabase>>;
let generationId: string;
let jobId: string;
let chunkIds: string[];
let feedJobId: string;
const cursorKey = new TextEncoder().encode("fixture-merge-cursor-material-not-secret-0001");
const reference = () => ({
  environment: "staging" as const,
  generationId,
  jobId,
  configVersion: "1",
  executorVersion: "1",
  promptVersion: "1",
  schemaVersion: "1",
});
const summary = {
  title: "架空統合要約",
  difficulty: "beginner",
  importanceScore: 50,
  keyPoints: ["架空ポイント"],
  oneLineSummary: "架空短文",
  summary: "架空要約本文",
  tags: [],
  whyItMatters: "架空理由",
};
let generated: string[];
function deps(kind: "chunk" | "summary"): GenerationDependencies {
  return {
    count: async () => ({ inputTokens: 100 }),
    gate: {
      reserve: async () => ({
        status: "reserved",
        permitId: crypto.randomUUID(),
        expiresAt: new Date(Date.now() + 5000).toISOString(),
        quotaVersion: "1",
      }),
      consume: async (value) => ({ status: "consumed", permitId: value.permitId }),
      report: async () => ({ status: "reported" }),
    },
    generate: async (input) => {
      generated.push(input.prompt);
      return {
        output:
          kind === "chunk"
            ? { kind: "chunk", text: `架空部分要約${generated.length}` }
            : { kind: "summary", summary },
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    },
  };
}
function context() {
  const now = Date.now();
  return {
    auth: {
      authVersion: "v1" as const,
      environment: "staging" as const,
      direction: "cf-to-node" as const,
      requestId: crypto.randomUUID(),
      nonce: crypto.randomUUID(),
      issuedAt: now,
      expiresAt: now + 60000,
      keyId: "fixture",
      executorVersion: "1",
    },
    signal: new AbortController().signal,
    deadlineAt: now + 60000,
    assertTimeLeft() {},
  };
}
const config = () => ({
  db: database.db,
  configVersion: "1",
  executorVersion: "1",
  promptVersion: "1",
  schemaVersion: "1",
  primaryModel: "fixture-primary",
  fallbackModel: "fixture-fallback",
  maxOutputTokens: 1000,
  countVersion: "1",
});
function repository() {
  return new MergeInputRepository(database.db, cursorKey, ["fixture-primary", "fixture-fallback"]);
}
beforeAll(async () => {
  database = await createIntegrationDatabase();
});
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  generated = [];
  await database.pool.query("TRUNCATE sources CASCADE");
  const sourceId = (
    await database.pool.query(
      "INSERT INTO sources(name,site_url) VALUES ('fixture','https://fixture.example') RETURNING id",
    )
  ).rows[0].id;
  const articleId = (
    await database.pool.query(
      "INSERT INTO articles(source_id,title,original_url,normalized_url) VALUES ($1,'架空記事','https://fixture.example/article','https://fixture.example/article') RETURNING id",
      [sourceId],
    )
  ).rows[0].id;
  generationId = (
    await database.pool.query(
      "INSERT INTO collector_generations(environment,article_id,prompt_version,schema_version,config_version) VALUES ('staging',$1,'1','1','1') RETURNING id",
      [articleId],
    )
  ).rows[0].id;
  const identity = {
    environment: "staging" as const,
    stage: "extract" as const,
    logicalEntityId: generationId,
    inputHash: "a".repeat(64),
    model: "",
    promptVersion: "1",
    schemaVersion: "1",
  };
  const claim = await new OperationRepository(database.db).claim({
    ...identity,
    operationKey: await operationKey(identity),
    generationId,
    owner: "fixture",
    leaseMs: 360000,
  });
  if (claim.status !== "claimed") throw new Error("Expected claim");
  await new PayloadRepository(database.db, cursorKey).saveExtraction(claim.fence, {
    generationId,
    contentText: "架空本文0架空本文1架空本文2",
    contentHtml: null,
    extractionStatus: "fallback",
    chunkerVersion: "1",
    chunks: ["架空本文0", "架空本文1", "架空本文2"],
  });
  chunkIds = (await database.pool.query("SELECT id FROM collector_chunks ORDER BY index")).rows.map(
    (row) => row.id,
  );
  jobId = crypto.randomUUID();
  const endpointId = (
    await database.pool.query(
      "INSERT INTO feed_endpoints(source_id,url) VALUES ($1,'https://fixture.example/feed') RETURNING id",
      [sourceId],
    )
  ).rows[0].id;
  feedJobId = (
    await database.pool.query("INSERT INTO crawl_jobs(feed_endpoint_id) VALUES ($1) RETURNING id", [
      endpointId,
    ])
  ).rows[0].id;
  const discoveryId = (
    await database.pool.query(
      "INSERT INTO collector_discoveries(environment,job_id,feed_id,scheduled_at,executor_version,config_version,manifest_hash) VALUES ('staging',$1,'fixture',now(),'1','1',$2) RETURNING id",
      [jobId, "a".repeat(64)],
    )
  ).rows[0].id;
  await database.pool.query(
    "INSERT INTO collector_candidates(discovery_id,normalized_url,article_id,disposition,metadata) VALUES ($1,'https://fixture.example/article',$2,'process',$3)",
    [
      discoveryId,
      articleId,
      JSON.stringify({ generationId, feedJobId, sourceId, bookmarks: 10, views: 20, score: 30 }),
    ],
  );
});
async function completeChunk(index: number, tier: "primary" | "fallback" = "primary") {
  const stage = createSummarizeChunkStage({ ...config(), dependencies: deps("chunk") });
  const request = {
    apiVersion: "v1" as const,
    ...reference(),
    stage: "summarize-chunk" as const,
    workId: crypto.randomUUID(),
    operationKey: "a".repeat(64),
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
    chunkId: chunkIds[index]!,
    modelTier: tier,
    apiAttempt: 1,
  };
  // Version fields belong to the stage config; only the HTTP contract fields are sent.
  const { promptVersion: _prompt, schemaVersion: _schema, ...body } = request;
  body.operationKey = await operationKey((await stage.resolve(body)).identity);
  expect(await stage.execute(body, context())).toMatchObject({ status: "succeeded" });
}
it("requires all chunks, selects success in index order and reuses a fixed manifest", async () => {
  await completeChunk(2);
  await completeChunk(0, "fallback");
  await expect(repository().createOrdered(reference())).rejects.toThrow(
    "SUMMARY_RESULTS_INCOMPLETE",
  );
  await completeChunk(1);
  const first = await repository().createOrdered(reference());
  expect(await repository().createOrdered(reference())).toEqual(first);
  const stored = await repository().read(reference(), first.manifestId);
  expect(stored.parts.map((part) => part.index)).toEqual([0, 1, 2]);
  expect(stored.parts.map((part) => part.text)).toEqual([
    "架空部分要約2",
    "架空部分要約3",
    "架空部分要約1",
  ]);
});
it("merges saved results once through the gate and replays without regenerating chunks", async () => {
  for (let i = 0; i < 3; i++) await completeChunk(i);
  const manifest = await repository().createOrdered(reference());
  const stage = createMergeSummaryStage({ ...config(), cursorKey, dependencies: deps("summary") });
  const request = {
    apiVersion: "v1" as const,
    environment: "staging" as const,
    generationId,
    jobId,
    configVersion: "1",
    executorVersion: "1",
    stage: "merge-summary" as const,
    workId: crypto.randomUUID(),
    operationKey: "a".repeat(64),
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
    orderedResultManifestId: manifest.manifestId,
    modelTier: "primary" as const,
    apiAttempt: 1,
  };
  request.operationKey = await operationKey((await stage.resolve(request)).identity);
  const first = await stage.execute(request, context());
  expect(first).toMatchObject({ status: "succeeded", stage: "merge-summary" });
  expect(await stage.execute(request, context())).toEqual(first);
  expect(generated).toHaveLength(4);
  expect(generated[3]).toContain("架空部分要約1");
  if (first.status !== "succeeded" || first.stage !== "merge-summary")
    throw new Error("Expected merge success");
  const persist = createPersistStage(database.db);
  const publication = {
    apiVersion: "v1" as const,
    environment: "staging" as const,
    generationId,
    jobId,
    configVersion: "1",
    executorVersion: "1",
    stage: "persist" as const,
    workId: crypto.randomUUID(),
    operationKey: "a".repeat(64),
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
    finalResultId: first.finalResultId,
    feedJobId,
  };
  publication.operationKey = await operationKey((await persist.resolve(publication)).identity);
  expect(await persist.execute(publication, context())).toMatchObject({
    status: "succeeded",
    publication: "published",
  });
  expect(
    (await database.pool.query("SELECT summary_status FROM articles")).rows[0].summary_status,
  ).toBe("summarized");
  expect(
    (await database.pool.query("SELECT summary_json FROM article_summaries")).rows[0].summary_json
      .one_line_summary,
  ).toBe("架空短文");
  expect(
    (await database.pool.query("SELECT status FROM collector_generations")).rows[0].status,
  ).toBe("succeeded");
  expect(await stage.execute(request, context())).toEqual(first);
  expect(generated).toHaveLength(4);
});
it("rejects foreign jobs, environments and corrupted result manifest membership", async () => {
  for (let i = 0; i < 3; i++) await completeChunk(i);
  const manifest = await repository().createOrdered(reference());
  await expect(
    repository().read({ ...reference(), jobId: crypto.randomUUID() }, manifest.manifestId),
  ).rejects.toThrow("SUMMARY_REFERENCE_MISMATCH");
  await expect(
    repository().read({ ...reference(), environment: "production" }, manifest.manifestId),
  ).rejects.toThrow("SUMMARY_REFERENCE_MISMATCH");
  await database.pool.query(
    "UPDATE collector_manifest_entries SET data=jsonb_set(data,'{index}','2') WHERE manifest_id=$1 AND position=0",
    [manifest.manifestId],
  );
  await expect(repository().read(reference(), manifest.manifestId)).rejects.toThrow(
    "SUMMARY_RESULTS_INCOMPLETE",
  );
});
it("rejects chunk order changed after extraction even when payload hashes still match", async () => {
  for (let i = 0; i < 3; i++) await completeChunk(i);
  const manifest = await repository().createOrdered(reference());
  await database.pool.query("UPDATE collector_chunks SET index=3 WHERE id=$1", [chunkIds[0]]);
  await database.pool.query("UPDATE collector_chunks SET index=0 WHERE id=$1", [chunkIds[1]]);
  await database.pool.query("UPDATE collector_chunks SET index=1 WHERE id=$1", [chunkIds[0]]);
  await expect(repository().read(reference(), manifest.manifestId)).rejects.toThrow(
    "SUMMARY_INPUT_INTEGRITY_MISMATCH",
  );
});
it("reuses successful chunk results when a rejected merge switches to the configured fallback", async () => {
  const { GenerationTransportError } =
    await import("../../../apps/collector/src/stages/generation-sender.js");
  for (let i = 0; i < 3; i++) await completeChunk(i);
  const manifest = await repository().createOrdered(reference());
  const dependencies = deps("summary");
  dependencies.generate = async (input) => {
    generated.push(input.prompt);
    throw new GenerationTransportError("rejected");
  };
  const stage = createMergeSummaryStage({ ...config(), cursorKey, dependencies });
  const request = {
    apiVersion: "v1" as const,
    environment: "staging" as const,
    generationId,
    jobId,
    configVersion: "1",
    executorVersion: "1",
    stage: "merge-summary" as const,
    workId: crypto.randomUUID(),
    operationKey: "a".repeat(64),
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
    orderedResultManifestId: manifest.manifestId,
    modelTier: "primary" as "primary" | "fallback",
    apiAttempt: 1,
  };
  request.operationKey = await operationKey((await stage.resolve(request)).identity);
  expect(await stage.execute(request, context())).toMatchObject({
    status: "failed",
    errorCode: "GEMINI_REJECTED",
  });
  dependencies.generate = deps("summary").generate;
  request.modelTier = "fallback";
  request.operationKey = await operationKey((await stage.resolve(request)).identity);
  expect(await stage.execute(request, context())).toMatchObject({ status: "succeeded" });
  expect(await repository().createOrdered(reference())).toEqual(manifest);
  expect(generated).toHaveLength(5);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS n FROM collector_results WHERE effective_model IN ('fixture-primary','fixture-fallback') AND validated_json->>'kind'='chunk'",
      )
    ).rows[0].n,
  ).toBe(3);
});
