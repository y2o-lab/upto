import { describe, expect, it } from "vitest";

import { getArticlesByIds, getArticlesPage, mapArticleRow } from "./articles";

describe("mapArticleRow", () => {
  it("maps DB rows and snake_case summary JSON into feed articles", () => {
    const article = mapArticleRow({
      bookmarks: 12,
      bullets: ["要点1"],
      createdAt: new Date("2026-06-07T00:30:00.000Z"),
      id: "00000000-0000-4000-8000-000000000001",
      modelId: "gemini-test",
      normalizedUrl: "https://example.com/a",
      originalUrl: "https://example.com/a?utm_source=test",
      publishedAt: new Date("2026-06-07T00:00:00.000Z"),
      score: 23,
      shortSummary: "短い要約",
      sourceId: "00000000-0000-4000-8000-100000000001",
      sourceName: "Example",
      sourceSiteUrl: "https://example.com",
      summaryJson: {
        difficulty: "advanced",
        one_line_summary: "1行要約",
        summary: "本文要約",
        tags: ["TypeScript", "Next.js"],
        title: "整えたタイトル",
        why_it_matters: "重要な理由",
      },
      title: "元タイトル",
      topics: [],
      views: 345,
    });

    expect(article).toMatchObject({
      bookmarks: 12,
      difficulty: "advanced",
      oneLineSummary: "1行要約",
      summary: "本文要約",
      tags: ["TypeScript", "Next.js"],
      title: "整えたタイトル",
      views: 345,
      whyItMatters: "重要な理由",
    });
    expect(article.publishedAt).toBe("2026-06-07T00:00:00.000Z");
  });
});

describe("getArticlesPage", () => {
  it("returns a first fixture page with a next cursor", async () => {
    process.env.UPTO_WEB_USE_FIXTURE_DATA = "true";

    const page = await getArticlesPage({ limit: 2 });

    expect(page.articles).toHaveLength(2);
    expect(page.articles.map((article) => article.id)).toEqual([
      "00000000-0000-4000-8000-000000000001",
      "00000000-0000-4000-8000-000000000002",
    ]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(page.snapshotAt).toEqual(expect.any(String));
  });

  it("uses the next cursor to fetch the following fixture page", async () => {
    process.env.UPTO_WEB_USE_FIXTURE_DATA = "true";

    const firstPage = await getArticlesPage({ limit: 2 });
    const secondPage = await getArticlesPage({
      cursor: firstPage.nextCursor,
      limit: 2,
      snapshotAt: firstPage.snapshotAt,
    });

    expect(secondPage.articles).toHaveLength(2);
    expect(secondPage.articles.map((article) => article.id)).toEqual([
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000004",
    ]);
    expect(secondPage.hasMore).toBe(true);
    expect(secondPage.nextCursor).toEqual(expect.any(String));
    expect(secondPage.snapshotAt).toBe(firstPage.snapshotAt);
  });

  it("keeps fixture pagination within the feed session snapshot", async () => {
    process.env.UPTO_WEB_USE_FIXTURE_DATA = "true";
    const snapshotAt = "2026-06-06T17:00:00.000Z";

    const firstPage = await getArticlesPage({ limit: 2, snapshotAt });
    const secondPage = await getArticlesPage({
      cursor: firstPage.nextCursor,
      limit: 2,
      snapshotAt: firstPage.snapshotAt,
    });

    const articleIds = [...firstPage.articles, ...secondPage.articles].map((article) => article.id);
    expect(firstPage.snapshotAt).toBe(snapshotAt);
    expect(secondPage.snapshotAt).toBe(snapshotAt);
    expect(articleIds).toEqual([
      "00000000-0000-4000-8000-000000000004",
      "00000000-0000-4000-8000-000000000005",
      "00000000-0000-4000-8000-000000000006",
      "00000000-0000-4000-8000-000000000007",
    ]);
    expect(articleIds).not.toContain("00000000-0000-4000-8000-000000000003");
  });

  it("returns no cursor on the final fixture page", async () => {
    process.env.UPTO_WEB_USE_FIXTURE_DATA = "true";

    let cursor: string | null = null;
    let finalPage = await getArticlesPage({ limit: 5 });
    while (finalPage.hasMore) {
      cursor = finalPage.nextCursor;
      finalPage = await getArticlesPage({ cursor, limit: 5 });
    }

    expect(finalPage.articles.length).toBeGreaterThan(0);
    expect(finalPage.hasMore).toBe(false);
    expect(finalPage.nextCursor).toBeNull();
  });

  it("rejects invalid cursors", async () => {
    process.env.UPTO_WEB_USE_FIXTURE_DATA = "true";

    await expect(getArticlesPage({ cursor: "not-a-cursor", limit: 2 })).rejects.toThrow(
      "Invalid article page cursor",
    );
  });

  it("rejects invalid feed session snapshots", async () => {
    process.env.UPTO_WEB_USE_FIXTURE_DATA = "true";

    await expect(getArticlesPage({ limit: 2, snapshotAt: "not-a-date" })).rejects.toThrow(
      "Invalid article page snapshot",
    );
  });
});

describe("getArticlesByIds", () => {
  it("returns fixture articles in the same order as the saved article IDs", async () => {
    process.env.UPTO_WEB_USE_FIXTURE_DATA = "true";

    const articles = await getArticlesByIds([
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000001",
    ]);

    expect(articles.map((article) => article.id)).toEqual([
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000001",
    ]);
  });
});
