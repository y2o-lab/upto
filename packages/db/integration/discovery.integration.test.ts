import { operationKey, type StageRequest } from "@upto/domain/batch";
import { beforeAll, afterAll, beforeEach, expect, it } from "vitest";

import type { HttpExecutionContext } from "../../../apps/collector/src/http/handler.js";

import { createDiscoveryStage } from "../../../apps/collector/src/stages/discovery.js";
import { ManifestRepository } from "../src/collector/manifests.js";
import { createIntegrationDatabase } from "./database.js";
let database: Awaited<ReturnType<typeof createIntegrationDatabase>>;
let request: Extract<StageRequest, { stage: "discovery" }>;
const cursorKey = new TextEncoder().encode("fixture-discovery-cursor-material-0001");
const feed = {
  kind: "rss" as const,
  name: "fixture",
  siteUrl: "https://fixture.example",
  url: "https://fixture.example/feed",
};
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
    deadlineAt: now + 60000,
    assertTimeLeft() {},
  };
}
function stage(fetcher: typeof fetch) {
  return createDiscoveryStage({
    db: database.db,
    cursorKey,
    feeds: new Map([
      ["fixture", feed],
      ["other", { ...feed, name: "other", url: "https://fixture.example/other" }],
    ]),
    configVersion: "1",
    executorVersion: "1",
    promptVersion: "1",
    schemaVersion: "1",
    fetcher,
  });
}
const xml = `<rss><channel><item><title>架空記事</title><link>https://fixture.example/article?utm_source=fixture</link><description>架空の本文</description></item><item><title>重複候補</title><link>https://fixture.example/article</link></item><item><title>別記事</title><link>https://fixture.example/other-article</link></item></channel></rss>`;
beforeAll(async () => {
  database = await createIntegrationDatabase();
});
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  await database.pool.query("TRUNCATE sources, crawl_jobs CASCADE");
  request = {
    apiVersion: "v1",
    environment: "staging",
    stage: "discovery",
    jobId: crypto.randomUUID(),
    workId: crypto.randomUUID(),
    operationKey: "a".repeat(64),
    executorVersion: "1",
    configVersion: "1",
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
    feedId: "fixture",
    scheduledAt: "2026-10-11T00:00:00Z",
    maxItems: 100,
  };
});
async function prepared(value: ReturnType<typeof stage>, input = request) {
  input.operationKey = await operationKey((await value.resolve(input)).identity);
  return input;
}
it("deduplicates candidates and commits candidate/generation/manifest/result together", async () => {
  let calls = 0;
  const value = stage(async (_input, init) => {
    calls++;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return new Response(xml);
  });
  await prepared(value);
  const result = await value.execute(request, execution());
  expect(result).toMatchObject({ status: "succeeded", stage: "discovery", candidateCount: 2 });
  if (result.status !== "succeeded" || result.stage !== "discovery")
    throw new Error("Expected discovery");
  const page = await new ManifestRepository(database.db, cursorKey).page({
    apiVersion: "v1",
    environment: "staging",
    manifestId: result.manifestId,
    limit: 50,
  });
  expect(page.entries).toHaveLength(2);
  expect(page.entries[0]).toMatchObject({
    disposition: "process",
    generationId: expect.any(String),
    feedJobId: expect.any(String),
  });
  expect(await value.execute(request, execution())).toEqual(result);
  expect(calls).toBe(1);
  expect(
    (await database.pool.query("SELECT count(*)::int AS n FROM collector_generations")).rows[0].n,
  ).toBe(2);
});
it("shares aggregate job and generations across feeds while preserving per-feed metadata", async () => {
  const value = stage(async () => new Response(xml));
  await prepared(value);
  await value.execute(request, execution());
  const other = await prepared(value, { ...request, feedId: "other" });
  await value.execute(other, execution());
  expect(
    (
      await database.pool.query(
        "SELECT count(DISTINCT crawl_job_id)::int AS n FROM collector_discoveries",
      )
    ).rows[0].n,
  ).toBe(1);
  expect(
    (
      await database.pool.query(
        "SELECT count(DISTINCT feed_job_id)::int AS n FROM collector_discoveries",
      )
    ).rows[0].n,
  ).toBe(2);
  expect(
    (await database.pool.query("SELECT count(*)::int AS n FROM collector_generations")).rows[0].n,
  ).toBe(2);
  expect(
    (await database.pool.query("SELECT count(*)::int AS n FROM collector_candidates")).rows[0].n,
  ).toBe(4);
});
it("refuses a different job or input claiming the same schedule slot", async () => {
  const value = stage(async () => new Response(xml));
  await prepared(value);
  await value.execute(request, execution());
  await expect(value.resolve({ ...request, jobId: crypto.randomUUID() })).rejects.toThrow(
    "DISCOVERY_SLOT_CONFLICT",
  );
  await expect(value.resolve({ ...request, maxItems: 1 })).rejects.toThrow(
    "DISCOVERY_SLOT_CONFLICT",
  );
});
it("keeps a failed feed binding for finalization and lets another feed continue", async () => {
  const value = stage(async (input) =>
    String(input).endsWith("/feed") ? new Response(null, { status: 503 }) : new Response(xml),
  );
  await prepared(value);
  expect(await value.execute(request, execution())).toEqual({
    status: "failed",
    errorCode: "DISCOVERY_FETCH_FAILED",
    retryable: false,
  });
  const other = await prepared(value, { ...request, feedId: "other" });
  expect(await value.execute(other, execution())).toMatchObject({ status: "succeeded" });
  expect(
    (
      await database.pool.query(
        "SELECT count(DISTINCT crawl_job_id)::int AS n FROM collector_discoveries",
      )
    ).rows[0].n,
  ).toBe(1);
});
it("isolates one incompatible active generation instead of failing other candidates", async () => {
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
  await database.pool.query(
    "INSERT INTO collector_generations(environment,article_id,prompt_version,schema_version,config_version) VALUES ('staging',$1,'old','1','1')",
    [article],
  );
  const value = stage(async () => new Response(xml));
  await prepared(value);
  const result = await value.execute(request, execution());
  expect(result).toMatchObject({ status: "succeeded", candidateCount: 2 });
  const dispositions = (
    await database.pool.query(
      "SELECT disposition,metadata FROM collector_candidates ORDER BY normalized_url",
    )
  ).rows;
  expect(dispositions[0]).toMatchObject({
    disposition: "failed",
    metadata: { errorCode: "GENERATION_VERSION_CONFLICT" },
  });
  expect(dispositions[1].disposition).toBe("process");
});
it("rejects manifest references that do not belong to the candidate generation or feed job", async () => {
  const value = stage(async () => new Response(xml));
  await prepared(value);
  const result = await value.execute(request, execution());
  if (result.status !== "succeeded" || result.stage !== "discovery")
    throw new Error("Expected discovery");
  const manifests = new ManifestRepository(database.db, cursorKey);
  const page = await manifests.page({
    apiVersion: "v1",
    environment: "staging",
    manifestId: result.manifestId,
    limit: 50,
  });
  const first = page.entries[0];
  if (!first || !("candidateId" in first)) throw new Error("Expected candidate");
  for (const changed of [{ generationId: crypto.randomUUID() }, { feedJobId: crypto.randomUUID() }])
    await expect(
      manifests.create({
        id: crypto.randomUUID(),
        environment: "staging",
        kind: "candidates",
        discoveryId: result.discoveryId,
        entries: [{ ...first, ...changed }],
      }),
    ).rejects.toThrow("MANIFEST_REFERENCE_MISMATCH");
});
it("preserves published content and creates only metrics for an already published candidate", async () => {
  const source = (
    await database.pool.query(
      "INSERT INTO sources(name,site_url) VALUES ('fixture','https://fixture.example') RETURNING id",
    )
  ).rows[0].id;
  const article = (
    await database.pool.query(
      "INSERT INTO articles(source_id,title,original_url,normalized_url,summary_status) VALUES ($1,'公開済みタイトル','https://fixture.example/article','https://fixture.example/article','summarized') RETURNING id",
      [source],
    )
  ).rows[0].id;
  await database.pool.query(
    "INSERT INTO article_contents(article_id,content_text) VALUES ($1,'公開済み本文')",
    [article],
  );
  const value = stage(async () => new Response(xml));
  await prepared(value);
  await value.execute(request, execution());
  expect(
    (
      await database.pool.query(
        "SELECT disposition FROM collector_candidates WHERE article_id=$1",
        [article],
      )
    ).rows[0].disposition,
  ).toBe("alreadyPublished");
  expect(
    (await database.pool.query("SELECT title FROM articles WHERE id=$1", [article])).rows[0].title,
  ).toBe("公開済みタイトル");
  expect(
    (
      await database.pool.query("SELECT content_text FROM article_contents WHERE article_id=$1", [
        article,
      ])
    ).rows[0].content_text,
  ).toBe("公開済み本文");
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS n FROM collector_generations WHERE article_id=$1",
        [article],
      )
    ).rows[0].n,
  ).toBe(0);
  expect(
    (
      await database.pool.query(
        "SELECT count(*)::int AS n FROM article_metrics WHERE article_id=$1",
        [article],
      )
    ).rows[0].n,
  ).toBe(1);
});
it("rolls back articles, generations and candidates when manifest persistence fails", async () => {
  await database.pool.query(
    "CREATE FUNCTION fail_discovery_manifest() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture-discovery-failure'; END $$",
  );
  await database.pool.query(
    "CREATE TRIGGER fail_discovery_manifest BEFORE INSERT ON collector_manifest_entries FOR EACH ROW EXECUTE FUNCTION fail_discovery_manifest()",
  );
  try {
    const value = stage(async () => new Response(xml));
    await prepared(value);
    await expect(value.execute(request, execution())).rejects.toMatchObject({
      cause: { message: "fixture-discovery-failure" },
    });
    for (const table of [
      "articles",
      "collector_generations",
      "collector_candidates",
      "collector_manifests",
      "collector_results",
    ])
      expect((await database.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n).toBe(
        0,
      );
    expect(
      (await database.pool.query("SELECT count(*)::int AS n FROM collector_discoveries")).rows[0].n,
    ).toBe(1);
    expect(
      (await database.pool.query("SELECT status FROM collector_operations")).rows[0].status,
    ).toBe("running");
  } finally {
    await database.pool.query("DROP TRIGGER fail_discovery_manifest ON collector_manifest_entries");
    await database.pool.query("DROP FUNCTION fail_discovery_manifest()");
  }
});
it("allows only one feed fetch for concurrent requests in a slot", async () => {
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
    return new Response(xml);
  });
  await prepared(value);
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
    (await database.pool.query("SELECT count(*)::int AS n FROM collector_discoveries")).rows[0].n,
  ).toBe(1);
});
