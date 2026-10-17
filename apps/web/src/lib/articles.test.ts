import type * as DbModule from "@upto/db";

import { getDb } from "@upto/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getArticlesByIds, getArticlesPage, mapArticleRow } from "./articles";

vi.mock("@upto/db", async (importOriginal) => {
  const actual = await importOriginal<typeof DbModule>();
  return { ...actual, getDb: vi.fn() };
});

function createRow(
  overrides: Partial<Parameters<typeof mapArticleRow>[0]> = {},
): Parameters<typeof mapArticleRow>[0] {
  return {
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
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("UPTO_WEB_USE_FIXTURE_DATA", "true");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("mapArticleRow", () => {
  it("maps DB rows and snake_case summary JSON into feed articles", () => {
    const article = mapArticleRow(createRow());

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
  it("orders fixture articles by registration date before score", async () => {
    const page = await getArticlesPage({ limit: 2 });

    expect(page.articles).toHaveLength(2);
    expect(page.articles.map((article) => article.id)).toEqual([
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000001",
    ]);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(page.snapshotAt).toEqual(expect.any(String));
  });

  it("uses the next cursor to fetch the following fixture page", async () => {
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
    await expect(getArticlesPage({ cursor: "not-a-cursor", limit: 2 })).rejects.toThrow(
      "Invalid article page cursor",
    );
  });

  it("rejects invalid feed session snapshots", async () => {
    await expect(getArticlesPage({ limit: 2, snapshotAt: "not-a-date" })).rejects.toThrow(
      "Invalid article page snapshot",
    );
  });
});

describe("getArticlesByIds", () => {
  it("returns fixture articles in the same order as the saved article IDs", async () => {
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

describe("mapArticleRow fallbacks", () => {
  it.each([
    {},
    {
      title: "  ",
      summary: 42,
      one_line_summary: false,
      why_it_matters: [],
      difficulty: "expert",
      tags: "TypeScript",
      key_points: null,
    },
  ])("falls back to stored columns for missing or invalid summary fields: %j", (summaryJson) => {
    const article = mapArticleRow(
      createRow({
        summaryJson,
        bullets: [],
        topics: ["Fallback"],
        publishedAt: null,
        bookmarks: null,
        views: null,
        score: null,
      }),
    );
    expect(article).toMatchObject({
      title: "元タイトル",
      summary: "短い要約",
      oneLineSummary: "短い要約",
      whyItMatters: null,
      difficulty: "intermediate",
      tags: ["Fallback"],
      summaryBullets: [],
      publishedAt: null,
      bookmarks: 0,
      views: 0,
      score: 0,
    });
  });

  it("filters invalid JSON list entries and uses key points when stored bullets are empty", () => {
    const article = mapArticleRow(
      createRow({
        bullets: [],
        summaryJson: {
          tags: [null, "", "  ", 42, "React"],
          key_points: [false, "", "要点"],
        },
      }),
    );
    expect(article.tags).toEqual(["React"]);
    expect(article.summaryBullets).toEqual(["要点"]);
  });

  it("prefers stored bullets and falls back to topics when JSON tags have no usable entries", () => {
    const article = mapArticleRow(
      createRow({
        topics: ["React"],
        summaryJson: { tags: [null, " "], key_points: ["JSON要点"] },
      }),
    );
    expect(article.summaryBullets).toEqual(["要点1"]);
    expect(article.tags).toEqual(["React"]);
  });

  it.each(["beginner", "intermediate", "advanced"])(
    "preserves valid difficulty %s",
    (difficulty) => {
      expect(mapArticleRow(createRow({ summaryJson: { difficulty } })).difficulty).toBe(difficulty);
    },
  );
});

describe("article page boundaries", () => {
  const snapshotAt = "2026-06-08T00:00:00.000Z";

  it.each([
    [undefined, 10],
    [NaN, 10],
    [Infinity, 10],
    [-Infinity, 10],
    [0, 1],
    [-1, 1],
    [1, 1],
    [2.9, 2],
  ])("normalizes limit %s to %s", async (limit, expected) => {
    const page = await getArticlesPage(
      limit === undefined ? { snapshotAt } : { limit, snapshotAt },
    );
    expect(page.articles).toHaveLength(expected);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).not.toBeNull();
  });

  it("returns an empty terminal page when the snapshot precedes every article", async () => {
    expect(await getArticlesPage({ snapshotAt: "2000-01-01T00:00:00.000Z" })).toEqual({
      articles: [],
      hasMore: false,
      nextCursor: null,
      snapshotAt: "2000-01-01T00:00:00.000Z",
    });
  });

  it("includes articles registered exactly at the snapshot", async () => {
    const page = await getArticlesPage({ snapshotAt: "2026-06-07T02:00:00.000Z", limit: 1 });
    expect(page.articles.map(({ id }) => id)).toEqual(["00000000-0000-4000-8000-000000000001"]);
  });

  it("returns no continuation when the result count exactly equals the limit", async () => {
    const page = await getArticlesPage({ snapshotAt, limit: 12 });
    expect(page.articles).toHaveLength(12);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  it.each([
    { createdAt: "bad", id: "00000000-0000-4000-8000-000000000001", publishedAt: null, score: 1 },
    { createdAt: snapshotAt, id: "bad", publishedAt: null, score: 1 },
    {
      createdAt: snapshotAt,
      id: "00000000-0000-4000-8000-000000000001",
      publishedAt: "bad",
      score: 1,
    },
    {
      createdAt: snapshotAt,
      id: "00000000-0000-4000-8000-000000000001",
      publishedAt: null,
      score: "1",
    },
    {},
  ])("rejects a decodable cursor with invalid fields: %j", async (value) => {
    const cursor = Buffer.from(JSON.stringify(value)).toString("base64url");
    await expect(getArticlesPage({ cursor, snapshotAt })).rejects.toThrow(
      "Invalid article page cursor",
    );
  });

  it.each([
    {
      score: 62,
      publishedAt: "2026-06-07T01:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000002",
      includes: true,
    },
    {
      score: 60,
      publishedAt: "2026-06-07T01:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000002",
      includes: false,
    },
    {
      score: 61,
      publishedAt: "2026-06-07T02:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000002",
      includes: true,
    },
    {
      score: 61,
      publishedAt: "2026-06-07T00:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000002",
      includes: false,
    },
    { score: 61, publishedAt: null, id: "00000000-0000-4000-8000-000000000002", includes: false },
    {
      score: 61,
      publishedAt: "2026-06-07T01:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000003",
      includes: true,
    },
    {
      score: 61,
      publishedAt: "2026-06-07T01:00:00.000Z",
      id: "00000000-0000-4000-8000-000000000002",
      includes: false,
    },
  ])(
    "resolves cursor ties by score, publication date, then ID: %j",
    async ({ includes, ...tie }) => {
      const cursor = Buffer.from(
        JSON.stringify({ createdAt: "2026-06-07T03:00:00.000Z", ...tie }),
      ).toString("base64url");
      const page = await getArticlesPage({ cursor, snapshotAt, limit: 30 });
      expect(page.articles.some(({ id }) => id === "00000000-0000-4000-8000-000000000002")).toBe(
        includes,
      );
      expect(page.articles.some(({ id }) => id === "00000000-0000-4000-8000-000000000001")).toBe(
        true,
      );
    },
  );
});

describe("saved article ID boundaries", () => {
  it("returns an empty list for no saved IDs", async () => {
    expect(await getArticlesByIds([])).toEqual([]);
  });

  it("deduplicates IDs and omits missing articles while preserving requested order", async () => {
    const ids = ["00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000001"];
    const result = await getArticlesByIds([
      ids[0]!,
      "00000000-0000-4000-8000-999999999999",
      ids[1]!,
      ids[0]!,
    ]);
    expect(result.map(({ id }) => id)).toEqual(ids);
  });
});

describe("database-backed page size", () => {
  it.each([30, 31, 100])(
    "caps limit %s at 30 and fetches one extra row to detect continuation",
    async (limit) => {
      vi.stubEnv("UPTO_WEB_USE_FIXTURE_DATA", "false");
      const rows = Array.from({ length: 31 }, (_, index) =>
        createRow({
          id: `00000000-0000-4000-8000-${String(100 - index).padStart(12, "0")}`,
        }),
      );
      const query = {
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        leftJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        orderBy: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue(rows),
      };
      vi.mocked(getDb).mockReturnValue({
        select: vi.fn().mockReturnValue(query),
      } as unknown as ReturnType<typeof getDb>);
      const page = await getArticlesPage({ limit, snapshotAt: "2026-06-08T00:00:00.000Z" });
      expect(query.limit).toHaveBeenCalledWith(31);
      expect(page.articles).toHaveLength(30);
      expect(page.hasMore).toBe(true);
      expect(page.articles.at(-1)?.id).toBe(rows[29]!.id);
      const cursor = JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString("utf8"));
      expect(cursor.id).toBe(rows[29]!.id);
    },
  );
});
