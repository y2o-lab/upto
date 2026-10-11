import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";

import {
  createPersistence,
  type ManagedPersistence,
  type SaveArticleInput,
} from "../../../apps/collector/src/persistence.js";
import { localTestDatabaseUrl } from "../src/testing/local-database.js";
const url = localTestDatabaseUrl(process.env.COLLECTOR_TEST_DATABASE_URL);
const testDatabase = `upto_collector_test_${randomUUID().replaceAll("-", "")}`;
const schema = "public";
const scopedUrl = new URL(url);
scopedUrl.pathname = `/${testDatabase}`;
let admin: Pool;
let pool: Pool;
let persistence: ManagedPersistence;
let sourceId: string;
const normalizedUrl = "https://fixture.example/article";
const input: SaveArticleInput = {
  content: { status: "extracted", contentHtml: "<p>架空本文</p>", contentText: "架空本文" },
  item: {
    url: normalizedUrl,
    title: "架空記事",
    publishedAt: null,
    bookmarks: 1,
    views: 2,
    summaryText: "架空本文",
    contentHtml: null,
  },
  modelId: "fixture-model",
  normalizedUrl,
  score: 50,
  sourceId: "",
  summary: {
    title: "架空要約",
    difficulty: "beginner",
    importanceScore: 50,
    keyPoints: ["架空ポイント"],
    oneLineSummary: "架空短文",
    summary: "架空本文要約",
    tags: ["fixture"],
    whyItMatters: "架空理由",
  },
};

beforeAll(async () => {
  admin = new Pool({ connectionString: url.toString(), connectionTimeoutMillis: 5000 });
  await admin.query(`CREATE DATABASE ${testDatabase}`);
  pool = new Pool({ connectionString: scopedUrl.toString(), max: 4 });
  await migrate(drizzle(pool), {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    migrationsSchema: "drizzle",
  });
  persistence = createPersistence(scopedUrl.toString());
  const result = await pool.query(
    "INSERT INTO sources(name,site_url) VALUES ('fixture', 'https://fixture.example') RETURNING id",
  );
  sourceId = result.rows[0].id;
});
afterEach(async () => {
  for (const table of ["articles", "article_contents", "article_summaries", "article_metrics"])
    await pool.query(`DROP TRIGGER IF EXISTS fail_save ON ${table}`);
  await pool.query("TRUNCATE articles CASCADE");
});
afterAll(async () => {
  await persistence?.close();
  await pool?.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${testDatabase}`);
    await admin.end();
  }
});
async function counts() {
  const result = await pool.query(
    "SELECT (SELECT count(*)::int FROM articles) AS articles, (SELECT count(*)::int FROM article_contents) AS contents, (SELECT count(*)::int FROM article_summaries) AS summaries, (SELECT count(*)::int FROM article_metrics) AS metrics",
  );
  return result.rows[0];
}

describe("article persistence on real PostgreSQL", () => {
  it("commits the full article and publishes only when all dependent writes finish", async () => {
    const articleId = await persistence.saveArticle({ ...input, sourceId });
    expect(await counts()).toEqual({ articles: 1, contents: 1, summaries: 1, metrics: 1 });
    expect(await persistence.findArticleByNormalizedUrl(normalizedUrl)).toEqual({
      id: articleId,
      summaryStatus: "summarized",
    });
  });
  it.each(["article_contents", "article_summaries", "article_metrics", "articles"])(
    "rolls back every write when %s fails",
    async (table) => {
      await pool.query(
        `CREATE OR REPLACE FUNCTION ${schema}.fail_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_failure'; END $$`,
      );
      await pool.query(
        `CREATE TRIGGER fail_save BEFORE ${table === "articles" ? "UPDATE" : "INSERT"} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${schema}.fail_write()`,
      );
      await expect(persistence.saveArticle({ ...input, sourceId })).rejects.toThrow();
      expect(await counts()).toEqual({ articles: 0, contents: 0, summaries: 0, metrics: 0 });
    },
  );
  it("protects published success from late failures and repeated saves", async () => {
    const articleId = await persistence.saveArticle({ ...input, sourceId });
    await persistence.markArticleFailed({
      item: input.item,
      normalizedUrl,
      sourceId,
      error: new Error("fixture_failure"),
    });
    const repeated = await persistence.saveArticle({
      ...input,
      sourceId,
      content: { ...input.content, contentText: "変更本文" },
      summary: { ...input.summary, title: "変更要約" },
    });
    expect(repeated).toBe(articleId);
    const rows = await pool.query(
      "SELECT a.summary_status, a.retry_count, a.title, c.content_text FROM articles a JOIN article_contents c ON c.article_id=a.id",
    );
    expect(rows.rows).toEqual([
      { summary_status: "summarized", retry_count: 0, title: "架空要約", content_text: "架空本文" },
    ]);
    expect(await counts()).toEqual({ articles: 1, contents: 1, summaries: 1, metrics: 1 });
  });
  it("serializes simultaneous saves across separate PG pools without replacing the first success", async () => {
    const other = createPersistence(scopedUrl.toString());
    try {
      const result = await Promise.all([
        persistence.saveArticle({ ...input, sourceId }),
        other.saveArticle({ ...input, sourceId }),
      ]);
      expect(result[0]).toBe(result[1]);
      expect(await counts()).toEqual({ articles: 1, contents: 1, summaries: 1, metrics: 1 });
    } finally {
      await other.close();
    }
  });
  it("retains the existing rollback-debug transaction behavior", async () => {
    const result = await persistence.runInRollbackTransaction!(async (scoped) =>
      scoped.saveArticle({ ...input, sourceId }),
    );
    expect(result).toMatch(/^[a-f0-9-]+$/);
    expect(await counts()).toEqual({ articles: 0, contents: 0, summaries: 0, metrics: 0 });
  });
});
