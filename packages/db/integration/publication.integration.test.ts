import { signRequest } from "@upto/domain/batch";
import { operationKey } from "@upto/domain/batch";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";

import { createCollectorHandler } from "../../../apps/collector/src/http/handler.js";
import { createRepositoryHttpServices } from "../../../apps/collector/src/http/repositories.js";
import { createPersistStage } from "../../../apps/collector/src/stages/persist.js";
import {
  GenerationRepository,
  OperationRepository,
  PayloadRepository,
} from "../src/collector/index.js";
import { NonceRepository } from "../src/collector/nonces.js";
import { PublicationRepository } from "../src/collector/publication.js";
import { createIntegrationDatabase } from "./database.js";

let context: Awaited<ReturnType<typeof createIntegrationDatabase>>;
let sourceId: string;
let articleId: string;
let generationId: string;
let finalResultId: string;
let publication: PublicationRepository;
const cursorKey = new TextEncoder().encode("fixture-cursor-key-material-not-real-0001");
const summary = {
  title: "架空要約",
  difficulty: "beginner" as const,
  importanceScore: 60,
  keyPoints: ["架空ポイント"],
  oneLineSummary: "架空短文",
  summary: "架空要約本文",
  tags: ["fixture"],
  whyItMatters: "架空理由",
};
const metrics = { bookmarks: 2, views: 3, score: 50 };
async function claim(stage: "extract" | "summarize-chunk", model: string) {
  const identity = {
    environment: "staging" as const,
    stage,
    logicalEntityId: generationId,
    inputHash: "a".repeat(64),
    model,
    promptVersion: "1",
    schemaVersion: "1",
  };
  const value = await new OperationRepository(context.db).claim({
    ...identity,
    generationId,
    operationKey: await operationKey(identity),
    owner: "fixture",
    leaseMs: 360000,
  });
  if (value.status !== "claimed") throw new Error("Expected claim");
  return value;
}
async function prepare() {
  const article = await context.pool.query(
    "INSERT INTO articles(source_id,title,original_url,normalized_url) VALUES ($1,'架空記事',$2,$2) RETURNING id",
    [sourceId, "https://fixture.example/" + crypto.randomUUID()],
  );
  articleId = article.rows[0].id;
  const joined = await new GenerationRepository(context.db).join({
    environment: "staging",
    articleId,
    promptVersion: "1",
    schemaVersion: "1",
    configVersion: "1",
  });
  if (joined.status !== "joined") throw new Error("Expected generation");
  generationId = joined.generationId;
  await new PayloadRepository(context.db, cursorKey).saveExtraction(
    (await claim("extract", "")).fence,
    {
      generationId,
      contentText: "架空本文",
      contentHtml: "<p>架空本文</p>",
      extractionStatus: "extracted",
      chunkerVersion: "1",
      chunks: ["架空本文"],
    },
  );
  const generation = await claim("summarize-chunk", "fixture-model");
  const operations = new OperationRepository(context.db);
  await operations.markSent(generation.fence, {
    attempt: 1,
    permitId: crypto.randomUUID(),
    reservedTokens: 10,
    countVersion: "1",
    quotaVersion: "1",
  });
  finalResultId = await operations.complete(generation.fence, {
    output: { kind: "summary", summary },
    effectiveModel: "fixture-model",
    usage: { inputTokens: 10, outputTokens: 5 },
  });
}
async function publisher() {
  const identity = (
    await publication.describe({ environment: "staging", generationId, finalResultId })
  ).identity;
  const value = await new OperationRepository(context.db).claim({
    ...identity,
    generationId,
    operationKey: await operationKey(identity),
    owner: "publisher",
    leaseMs: 360000,
  });
  if (value.status !== "claimed") throw new Error("Expected publisher");
  return value;
}
beforeAll(async () => {
  context = await createIntegrationDatabase();
  publication = new PublicationRepository(context.db);
  const source = await context.pool.query(
    "INSERT INTO sources(name,site_url) VALUES ('fixture','https://fixture.example') RETURNING id",
  );
  sourceId = source.rows[0].id;
});
afterEach(async () => {
  for (const table of [
    "articles",
    "article_contents",
    "article_summaries",
    "article_metrics",
    "collector_operations",
  ])
    await context.pool.query(`DROP TRIGGER IF EXISTS fail_publication ON ${table}`);
  await context.pool.query("TRUNCATE articles CASCADE");
});
afterAll(async () => {
  await context?.close();
});
async function graph() {
  return (
    await context.pool.query(
      "SELECT a.title,a.summary_status,c.content_text,s.summary_json,m.score FROM articles a LEFT JOIN article_contents c ON c.article_id=a.id LEFT JOIN article_summaries s ON s.article_id=a.id LEFT JOIN article_metrics m ON m.article_id=a.id WHERE a.id=$1",
      [articleId],
    )
  ).rows[0];
}

describe("atomic final publication", () => {
  it("publishes the existing Web/Trigger-compatible graph and finishes operation and generation", async () => {
    await prepare();
    const value = await publisher();
    const response = await publication.publish(value.fence, {
      generationId,
      finalResultId,
      metrics,
    });
    expect(response).toEqual({
      status: "succeeded",
      stage: "persist",
      articleId,
      publication: "published",
    });
    expect(await graph()).toMatchObject({
      title: "架空要約",
      summary_status: "summarized",
      content_text: "架空本文",
      score: 50,
      summary_json: {
        title: "架空要約",
        one_line_summary: "架空短文",
        key_points: ["架空ポイント"],
        importance_score: 60,
      },
    });
    expect(
      (await context.pool.query("SELECT status,lease_owner FROM collector_generations")).rows[0],
    ).toEqual({ status: "succeeded", lease_owner: null });
    expect(
      (await new OperationRepository(context.db).status("staging", value.fence.operationKey))
        .status,
    ).toBe("succeeded");
  });
  it.each([
    "articles",
    "article_contents",
    "article_summaries",
    "article_metrics",
    "collector_operations",
  ])("rolls the publication graph and success back when %s fails", async (table) => {
    await prepare();
    const value = await publisher();
    await context.pool.query(
      `CREATE OR REPLACE FUNCTION fail_publication_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_failure'; END $$`,
    );
    await context.pool.query(
      `CREATE TRIGGER fail_publication BEFORE ${table === "articles" || table === "collector_operations" ? "UPDATE" : "INSERT"} ON ${table} FOR EACH ROW EXECUTE FUNCTION fail_publication_write()`,
    );
    await expect(
      publication.publish(value.fence, { generationId, finalResultId, metrics }),
    ).rejects.toThrow();
    expect(await graph()).toMatchObject({
      summary_status: "pending",
      content_text: null,
      summary_json: null,
      score: null,
    });
    expect(
      (await new OperationRepository(context.db).status("staging", value.fence.operationKey))
        .status,
    ).toBe("running");
    expect(
      (await context.pool.query("SELECT status FROM collector_generations")).rows[0].status,
    ).toBe("running");
  });
  it("rejects unrelated generation/result references, version mismatches and old owners", async () => {
    await prepare();
    const value = await publisher();
    await expect(
      publication.describe({ environment: "production", generationId, finalResultId }),
    ).rejects.toThrow("PUBLICATION_REFERENCE_MISMATCH");
    await expect(
      publication.describe({
        environment: "staging",
        generationId,
        finalResultId: crypto.randomUUID(),
      }),
    ).rejects.toThrow("PUBLICATION_REFERENCE_MISMATCH");
    await expect(
      publication.publish(
        { ...value.fence, leaseEpoch: 99 },
        { generationId, finalResultId, metrics },
      ),
    ).rejects.toThrow("STALE_OPERATION_OWNER");
    await context.pool.query("UPDATE collector_generations SET schema_version='2'");
    await expect(
      publication.publish(value.fence, { generationId, finalResultId, metrics }),
    ).rejects.toThrow("PUBLICATION_VERSION_MISMATCH");
    expect((await graph()).summary_status).toBe("pending");
  });
  it("runs the real persist stage through signed HTTP and authorizes job/feed references before replay", async () => {
    await prepare();
    const feed = await context.pool.query(
      "INSERT INTO feed_endpoints(source_id,url) VALUES ($1,$2) RETURNING id",
      [sourceId, "https://fixture.example/feed-" + crypto.randomUUID()],
    );
    const job = await context.pool.query(
      "INSERT INTO crawl_jobs(feed_endpoint_id) VALUES ($1) RETURNING id",
      [feed.rows[0].id],
    );
    const jobId = crypto.randomUUID();
    const feedJobId = job.rows[0].id as string;
    const discovery = await context.pool.query(
      "INSERT INTO collector_discoveries(environment,job_id,feed_id,scheduled_at,executor_version,config_version,manifest_hash) VALUES ('staging',$1,$2,clock_timestamp(),'fixture','1',$3) RETURNING id",
      [jobId, crypto.randomUUID(), "a".repeat(64)],
    );
    await context.pool.query(
      "INSERT INTO collector_candidates(discovery_id,normalized_url,metadata,article_id,disposition) VALUES ($1,$2,$3,$4,'process')",
      [
        discovery.rows[0].id,
        (await context.pool.query("SELECT normalized_url FROM articles WHERE id=$1", [articleId]))
          .rows[0].normalized_url,
        JSON.stringify({ sourceId, feedJobId, ...metrics }),
        articleId,
      ],
    );
    const stage = createPersistStage(context.db);
    const services = createRepositoryHttpServices({
      db: context.db,
      cursorKey,
      resolve: stage.resolve,
      execute: stage.execute,
    });
    const key = new TextEncoder().encode("fixture-auth-key-material-not-real-0001");
    const handler = createCollectorHandler({
      environment: "staging",
      executorVersions: ["fixture"],
      configVersions: ["1"],
      keys: new Map([["fixture", key]]),
      consumeNonce: (input) => new NonceRepository(context.db).consume(input),
      services,
    });
    const identity = (
      await publication.describe({ environment: "staging", generationId, finalResultId })
    ).identity;
    const requestBody = {
      apiVersion: "v1",
      environment: "staging",
      executorVersion: "fixture",
      configVersion: "1",
      stage: "persist",
      jobId,
      workId: crypto.randomUUID(),
      operationKey: await operationKey(identity),
      deadlineAt: new Date(Date.now() + 60000).toISOString(),
      generationId,
      finalResultId,
      feedJobId,
    };
    async function send(value: typeof requestBody) {
      const body = new TextEncoder().encode(JSON.stringify(value));
      const url = "https://fixture.example/api/v1/persist";
      const now = Date.now();
      const headers = await signRequest(
        { method: "POST", url, body },
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
      return handler(new Request(url, { method: "POST", headers, body }));
    }
    const first = await send(requestBody);
    expect(first.status).toBe(200);
    const saved = await first.json();
    expect(saved).toMatchObject({ articleId, publication: "published" });
    await context.pool.query("UPDATE collector_discoveries SET executor_version='other'");
    expect((await send(requestBody)).status).toBe(409);
    await context.pool.query("UPDATE collector_discoveries SET executor_version='fixture'");
    await context.pool.query("UPDATE collector_discoveries SET config_version='other'");
    expect((await send(requestBody)).status).toBe(409);
    await context.pool.query("UPDATE collector_discoveries SET config_version='1'");
    await context.pool.query(
      "UPDATE collector_candidates SET metadata=metadata || jsonb_build_object('generationId',$1::text)",
      [crypto.randomUUID()],
    );
    expect((await send(requestBody)).status).toBe(409);
    await context.pool.query("UPDATE collector_candidates SET metadata=metadata - 'generationId'");
    const replay = await send({ ...requestBody, deadlineAt: new Date(0).toISOString() });
    expect(await replay.json()).toEqual(saved);
    expect((await send({ ...requestBody, jobId: crypto.randomUUID() })).status).toBe(409);
    expect((await send({ ...requestBody, feedJobId: crypto.randomUUID() })).status).toBe(409);
    await context.pool.query(
      "UPDATE collector_candidates SET normalized_url='https://fixture.example/wrong-article'",
    );
    expect((await send(requestBody)).status).toBe(409);
    expect((await graph()).summary_status).toBe("summarized");
    expect(
      (
        await context.pool.query(
          "SELECT count(*)::int AS count FROM collector_operations WHERE stage='persist'",
        )
      ).rows[0].count,
    ).toBe(1);
  });
  it("rejects an unfinished long-article result and reports existing graph gaps read-only", async () => {
    await prepare();
    await context.pool.query(
      'INSERT INTO collector_chunks(generation_id,"index",payload,input_hash) VALUES ($1,1,$2,$3)',
      [generationId, "架空追加chunk", "b".repeat(64)],
    );
    await expect(
      publication.describe({ environment: "staging", generationId, finalResultId }),
    ).rejects.toThrow("PUBLICATION_RESULT_INCOMPLETE");
    await context.pool.query("UPDATE articles SET summary_status='summarized' WHERE id=$1", [
      articleId,
    ]);
    expect(await publication.incompletePublished()).toEqual([
      { articleId, missingContent: true, missingSummary: true, missingMetrics: true },
    ]);
    expect((await graph()).summary_status).toBe("summarized");
    expect(
      (
        await context.pool.query(
          "SELECT count(*)::int AS count FROM collector_operations WHERE stage='persist'",
        )
      ).rows[0].count,
    ).toBe(0);
  });
  it("refuses publication when stored extraction text changes after summarization", async () => {
    await prepare();
    const value = await publisher();
    await context.pool.query("UPDATE collector_payloads SET content_text='改変本文'");
    await expect(
      publication.publish(value.fence, { generationId, finalResultId, metrics }),
    ).rejects.toThrow("PUBLICATION_VERSION_MISMATCH");
    expect((await graph()).summary_status).toBe("pending");
    expect(
      (await context.pool.query("SELECT count(*)::int AS n FROM article_summaries")).rows[0].n,
    ).toBe(0);
  });
  it("protects an already published graph from replacement and updates only metrics", async () => {
    await prepare();
    const value = await publisher();
    await context.pool.query(
      "INSERT INTO article_contents(article_id,content_text) VALUES ($1,'既存本文')",
      [articleId],
    );
    await context.pool.query(
      "INSERT INTO article_summaries(article_id,model_id,short_summary,bullets,summary_json) VALUES ($1,'old-model','既存要約','[]','{}')",
      [articleId],
    );
    await context.pool.query("INSERT INTO article_metrics(article_id,score) VALUES ($1,1)", [
      articleId,
    ]);
    await context.pool.query(
      "UPDATE articles SET title='既存記事',summary_status='summarized' WHERE id=$1",
      [articleId],
    );
    const response = await publication.publish(value.fence, {
      generationId,
      finalResultId,
      metrics,
    });
    expect(response.publication).toBe("alreadyPublished");
    expect(await graph()).toMatchObject({ title: "既存記事", content_text: "既存本文", score: 50 });
  });
});
