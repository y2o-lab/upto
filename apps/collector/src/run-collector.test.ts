import { calculateTrendScore, normalizeArticleUrl } from "@upto/domain";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Persistence } from "./persistence.js";
import type { Summarizer } from "./summarizer.js";

import { runCollector } from "./run-collector.js";

const baseConfig = {
  concurrency: 1,
  debug: false,
  dryRun: true,
  geminiModelDefault: "gemini-3.1-flash-lite",
  geminiModelImportant: "gemini-3.0-flash",
  geminiRateLimitMaxRetries: 2,
  geminiRequestsPerMinute: 5,
  maxItemsPerFeed: 20,
  summaryChunkChars: 12000,
};

describe("runCollector", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("can run in dry-run mode without secrets", async () => {
    const result = await runCollector({
      config: {
        ...baseConfig,
      },
      dependencies: {
        logger: () => undefined,
      },
      feeds: [
        {
          kind: "rss",
          name: "Example",
          siteUrl: "https://example.com",
          url: "https://example.com/feed.xml",
        },
      ],
    });

    expect(result.dryRun).toBe(true);
    expect(result.feedCount).toBe(1);
  });

  it("rolls back database writes and skips external requests in debug mode", async () => {
    const finishedJobs: unknown[] = [];
    const logEvents: Record<string, unknown>[] = [];
    const fetcher = vi.fn<typeof fetch>();
    const summarize = vi.fn<Summarizer["summarize"]>();
    let rollbackTransactionCount = 0;
    const persistence: Persistence = {
      async findArticleByNormalizedUrl() {
        throw new Error("findArticleByNormalizedUrl should not be called");
      },
      async finishFeedJob(_jobId, result) {
        finishedJobs.push(result);
      },
      async markArticleFailed() {
        throw new Error("markArticleFailed should not be called");
      },
      async runInRollbackTransaction<T>(callback: (transaction: Persistence) => Promise<T>) {
        rollbackTransactionCount += 1;
        return callback(persistence);
      },
      async saveArticle() {
        throw new Error("saveArticle should not be called");
      },
      async startFeedJob() {
        return {
          feedEndpointId: "feed-1",
          jobId: "job-1",
          sourceId: "source-1",
        };
      },
      async updateArticleMetrics() {
        throw new Error("updateArticleMetrics should not be called");
      },
    };

    const result = await runCollector({
      config: {
        ...baseConfig,
        debug: true,
      },
      dependencies: {
        fetcher,
        logger: (event) => logEvents.push(event),
        persistence,
        summarizer: {
          summarize,
        },
      },
      feeds: [
        {
          kind: "rss",
          name: "Example",
          siteUrl: "https://example.com",
          url: "https://example.com/feed.xml",
        },
      ],
    });

    expect(result).toEqual({
      articleCount: 0,
      dryRun: false,
      failedCount: 0,
      failedFeedCount: 0,
      feedCount: 1,
      successfulFeedCount: 1,
    });
    expect(rollbackTransactionCount).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(summarize).not.toHaveBeenCalled();
    expect(finishedJobs).toEqual([
      {
        errorSummary: null,
        failedCount: 0,
        fetchedCount: 0,
      },
    ]);
    expect(logEvents).toContainEqual({
      feed: "Example",
      jobId: "job-1",
      status: "debug_external_requests_skipped",
    });
  });

  it("closes persistence created for a collector run", async () => {
    const close = vi.fn(async () => undefined);
    const persistence = {
      close,
      findArticleByNormalizedUrl: vi.fn(),
      finishFeedJob: vi.fn(),
      markArticleFailed: vi.fn(),
      saveArticle: vi.fn(),
      startFeedJob: vi.fn(),
      updateArticleMetrics: vi.fn(),
    };

    await runCollector({
      config: {
        ...baseConfig,
        databaseUrl: "postgres://user:password@db.example.com:5432/postgres",
        dryRun: false,
      },
      dependencies: {
        createPersistence: () => persistence,
        logger: () => undefined,
        summarizer: { summarize: vi.fn() },
      },
      feeds: [],
    });

    expect(close).toHaveBeenCalledOnce();
  });

  it("fetches RSS items, summarizes them, and saves article data", async () => {
    const savedArticles: unknown[] = [];
    const finishedJobs: unknown[] = [];
    const longDescription = "これはテスト用の記事本文です。".repeat(90);
    const rss = `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0">
  <channel>
    <item>
      <title>TypeScript batch test</title>
      <link>https://example.com/articles/typescript-batch?utm_source=test</link>
      <pubDate>Sun, 07 Jun 2026 00:00:00 GMT</pubDate>
      <description>${longDescription}</description>
    </item>
  </channel>
</rss>`;
    const persistence: Persistence = {
      async findArticleByNormalizedUrl() {
        return null;
      },
      async finishFeedJob(_jobId, result) {
        finishedJobs.push(result);
      },
      async markArticleFailed() {
        throw new Error("markArticleFailed should not be called");
      },
      async saveArticle(input) {
        savedArticles.push(input);
        return "article-1";
      },
      async startFeedJob() {
        return {
          feedEndpointId: "feed-1",
          jobId: "job-1",
          sourceId: "source-1",
        };
      },
      async updateArticleMetrics() {
        throw new Error("updateArticleMetrics should not be called");
      },
    };
    const summarizer: Summarizer = {
      async summarize(article) {
        return {
          modelId: "test-model",
          summary: {
            difficulty: "intermediate",
            importanceScore: 42,
            keyPoints: ["RSSを取得する", "本文をfallbackする", "DBへ保存する"],
            oneLineSummary: `${article.title} のテスト要約です。`,
            summary: "RSSから取得した本文を使って要約し、保存する経路を検証している。",
            tags: ["TypeScript", "RSS"],
            title: article.title,
            whyItMatters: "外部依存を差し替えてcollectorの主要経路を検証できる。",
          },
        };
      },
    };

    const result = await runCollector({
      config: {
        ...baseConfig,
        dryRun: false,
        maxItemsPerFeed: 1,
      },
      dependencies: {
        fetcher: async () => new Response(rss),
        logger: () => undefined,
        persistence,
        summarizer,
      },
      feeds: [
        {
          kind: "rss",
          name: "Example",
          siteUrl: "https://example.com",
          url: "https://example.com/feed.xml",
        },
      ],
    });

    expect(result).toEqual({
      articleCount: 1,
      dryRun: false,
      failedCount: 0,
      failedFeedCount: 0,
      feedCount: 1,
      successfulFeedCount: 1,
    });
    expect(savedArticles).toHaveLength(1);
    expect(finishedJobs).toEqual([
      {
        errorSummary: null,
        failedCount: 0,
        fetchedCount: 1,
      },
    ]);
  });

  it("skips summarized duplicate articles before content fetch and summarization", async () => {
    vi.setSystemTime(new Date("2026-06-08T00:00:00Z"));
    const finishedJobs: unknown[] = [];
    const metricUpdates: unknown[] = [];
    const logEvents: Record<string, unknown>[] = [];
    const articleFetchUrls: string[] = [];
    const rss = createRss([
      {
        bookmarks: 10,
        description: "短いRSS本文",
        link: "https://example.com/articles/duplicate?utm_source=test",
        pubDate: "Sun, 07 Jun 2026 00:00:00 GMT",
        title: "Duplicate article",
      },
    ]);
    const summarize = vi.fn<Summarizer["summarize"]>();
    const persistence: Persistence = {
      async findArticleByNormalizedUrl(normalizedUrl) {
        expect(normalizedUrl).toBe("https://example.com/articles/duplicate");
        return {
          id: "article-1",
          summaryStatus: "summarized",
        };
      },
      async finishFeedJob(_jobId, result) {
        finishedJobs.push(result);
      },
      async markArticleFailed() {
        throw new Error("markArticleFailed should not be called");
      },
      async saveArticle() {
        throw new Error("saveArticle should not be called");
      },
      async startFeedJob() {
        return {
          feedEndpointId: "feed-1",
          jobId: "job-1",
          sourceId: "source-1",
        };
      },
      async updateArticleMetrics(input) {
        metricUpdates.push(input);
      },
    };

    const result = await runCollector({
      config: {
        ...baseConfig,
        dryRun: false,
        maxItemsPerFeed: 1,
      },
      dependencies: {
        fetcher: async (input) => {
          const url = toUrl(input);
          if (url === "https://example.com/feed.xml") {
            return new Response(rss);
          }
          articleFetchUrls.push(url);
          return new Response("<article>本文</article>");
        },
        logger: (event) => logEvents.push(event),
        persistence,
        summarizer: {
          summarize,
        },
      },
      feeds: [
        {
          kind: "rss",
          name: "Example",
          siteUrl: "https://example.com",
          url: "https://example.com/feed.xml",
        },
      ],
    });

    expect(result.articleCount).toBe(0);
    expect(finishedJobs).toEqual([
      {
        errorSummary: null,
        failedCount: 0,
        fetchedCount: 0,
      },
    ]);
    expect(articleFetchUrls).toHaveLength(0);
    expect(summarize).not.toHaveBeenCalled();
    expect(metricUpdates).toEqual([
      {
        articleId: "article-1",
        bookmarks: 10,
        score: calculateTrendScore({
          ageHours: 24,
          bookmarks: 10,
          views: 0,
        }),
        views: 0,
      },
    ]);
    expect(logEvents).toContainEqual({
      feed: "Example",
      normalizedUrl: "https://example.com/articles/duplicate",
      status: "article_skipped_duplicate",
      url: "https://example.com/articles/duplicate?utm_source=test",
    });
  });

  it("does not mark summarized duplicate articles failed when metrics update fails", async () => {
    const logEvents: Record<string, unknown>[] = [];
    const rss = createRss([
      {
        description: "短いRSS本文",
        link: "https://example.com/articles/metrics-failure?utm_source=test",
        pubDate: "Sun, 07 Jun 2026 00:00:00 GMT",
        title: "Metrics failure article",
      },
    ]);
    const summarize = vi.fn<Summarizer["summarize"]>();
    const persistence: Persistence = {
      async findArticleByNormalizedUrl() {
        return {
          id: "article-1",
          summaryStatus: "summarized",
        };
      },
      async finishFeedJob() {
        return undefined;
      },
      async markArticleFailed() {
        throw new Error("markArticleFailed should not be called");
      },
      async saveArticle() {
        throw new Error("saveArticle should not be called");
      },
      async startFeedJob() {
        return {
          feedEndpointId: "feed-1",
          jobId: "job-1",
          sourceId: "source-1",
        };
      },
      async updateArticleMetrics() {
        throw new Error("metrics write failed");
      },
    };

    const result = await runCollector({
      config: {
        ...baseConfig,
        dryRun: false,
        maxItemsPerFeed: 1,
      },
      dependencies: {
        fetcher: async () => new Response(rss),
        logger: (event) => logEvents.push(event),
        persistence,
        summarizer: {
          summarize,
        },
      },
      feeds: [
        {
          kind: "rss",
          name: "Example",
          siteUrl: "https://example.com",
          url: "https://example.com/feed.xml",
        },
      ],
    });

    expect(result).toEqual({
      articleCount: 0,
      dryRun: false,
      failedCount: 0,
      failedFeedCount: 0,
      feedCount: 1,
      successfulFeedCount: 1,
    });
    expect(summarize).not.toHaveBeenCalled();
    expect(logEvents).toContainEqual({
      error: "metrics write failed",
      feed: "Example",
      normalizedUrl: "https://example.com/articles/metrics-failure",
      status: "article_duplicate_metrics_update_failed",
      url: "https://example.com/articles/metrics-failure?utm_source=test",
    });
    expect(logEvents).toContainEqual({
      feed: "Example",
      normalizedUrl: "https://example.com/articles/metrics-failure",
      status: "article_skipped_duplicate",
      url: "https://example.com/articles/metrics-failure?utm_source=test",
    });
  });

  it.each(["failed", "pending"] as const)(
    "reprocesses duplicate articles whose summary status is %s",
    async (summaryStatus) => {
      const savedArticles: unknown[] = [];
      const metricUpdates: unknown[] = [];
      const rss = createRss([
        {
          description: "これは再処理テスト用の記事本文です。".repeat(90),
          link: "https://example.com/articles/retry?utm_source=test",
          pubDate: "Sun, 07 Jun 2026 00:00:00 GMT",
          title: "Retry article",
        },
      ]);
      const summarize = vi.fn<Summarizer["summarize"]>(async (article) => ({
        modelId: "test-model",
        summary: createSummary(article.title),
      }));
      const persistence: Persistence = {
        async findArticleByNormalizedUrl() {
          return {
            id: "article-1",
            summaryStatus,
          };
        },
        async finishFeedJob() {
          return undefined;
        },
        async markArticleFailed() {
          throw new Error("markArticleFailed should not be called");
        },
        async saveArticle(input) {
          savedArticles.push(input);
          return "article-1";
        },
        async startFeedJob() {
          return {
            feedEndpointId: "feed-1",
            jobId: "job-1",
            sourceId: "source-1",
          };
        },
        async updateArticleMetrics(input) {
          metricUpdates.push(input);
        },
      };

      const result = await runCollector({
        config: {
          ...baseConfig,
          dryRun: false,
          maxItemsPerFeed: 1,
        },
        dependencies: {
          fetcher: async () => new Response(rss),
          logger: () => undefined,
          persistence,
          summarizer: {
            summarize,
          },
        },
        feeds: [
          {
            kind: "rss",
            name: "Example",
            siteUrl: "https://example.com",
            url: "https://example.com/feed.xml",
          },
        ],
      });

      expect(result.articleCount).toBe(1);
      expect(summarize).toHaveBeenCalledOnce();
      expect(savedArticles).toHaveLength(1);
      expect(metricUpdates).toHaveLength(0);
    },
  );

  it("skips the second same normalized URL seen later in the same run", async () => {
    const savedUrls = new Map<string, string>();
    const logEvents: Record<string, unknown>[] = [];
    const rss = createRss([
      {
        description: "これは同一URLテスト用の記事本文です。".repeat(90),
        link: "https://example.com/articles/same?utm_source=test",
        pubDate: "Sun, 07 Jun 2026 00:00:00 GMT",
        title: "Same article",
      },
    ]);
    const summarize = vi.fn<Summarizer["summarize"]>(async (article) => ({
      modelId: "test-model",
      summary: createSummary(article.title),
    }));
    const persistence: Persistence = {
      async findArticleByNormalizedUrl(normalizedUrl) {
        const id = savedUrls.get(normalizedUrl);
        return id
          ? {
              id,
              summaryStatus: "summarized",
            }
          : null;
      },
      async finishFeedJob() {
        return undefined;
      },
      async markArticleFailed() {
        throw new Error("markArticleFailed should not be called");
      },
      async saveArticle(input) {
        const normalizedUrl = normalizeArticleUrl(input.item.url);
        savedUrls.set(normalizedUrl, "article-1");
        return "article-1";
      },
      async startFeedJob(feed) {
        return {
          feedEndpointId: `feed-${feed.name}`,
          jobId: `job-${feed.name}`,
          sourceId: `source-${feed.name}`,
        };
      },
      async updateArticleMetrics() {
        return undefined;
      },
    };

    const result = await runCollector({
      config: {
        ...baseConfig,
        dryRun: false,
        maxItemsPerFeed: 1,
      },
      dependencies: {
        fetcher: async () => new Response(rss),
        logger: (event) => logEvents.push(event),
        persistence,
        summarizer: {
          summarize,
        },
      },
      feeds: [
        {
          kind: "rss",
          name: "Feed A",
          siteUrl: "https://example.com/a",
          url: "https://example.com/a.xml",
        },
        {
          kind: "rss",
          name: "Feed B",
          siteUrl: "https://example.com/b",
          url: "https://example.com/b.xml",
        },
      ],
    });

    expect(result.articleCount).toBe(1);
    expect(summarize).toHaveBeenCalledOnce();
    expect(logEvents).toContainEqual({
      feed: "Feed B",
      normalizedUrl: "https://example.com/articles/same",
      status: "article_skipped_duplicate",
      url: "https://example.com/articles/same?utm_source=test",
    });
  });

  it("shares one summarizer across concurrent articles and preserves article-level failures", async () => {
    const failures: unknown[] = [];
    const savedArticles: unknown[] = [];
    const rss = createRss([
      {
        description: "本文A",
        link: "https://example.com/articles/concurrent-success",
        pubDate: "Sun, 07 Jun 2026 00:00:00 GMT",
        title: "Concurrent success",
      },
      {
        description: "本文B",
        link: "https://example.com/articles/concurrent-failure",
        pubDate: "Sun, 07 Jun 2026 00:00:00 GMT",
        title: "Concurrent failure",
      },
    ]);
    const startedTitles: string[] = [];
    let releaseSummaries: () => void = () => undefined;
    const summariesReleased = new Promise<void>((resolve) => {
      releaseSummaries = resolve;
    });
    let bothSummariesStarted: () => void = () => undefined;
    const bothSummariesStartedPromise = new Promise<void>((resolve) => {
      bothSummariesStarted = resolve;
    });
    const summarize = vi.fn<Summarizer["summarize"]>(async (article) => {
      startedTitles.push(article.title);
      if (startedTitles.length === 2) {
        bothSummariesStarted();
      }
      await summariesReleased;
      if (article.title === "Concurrent failure") {
        throw new Error("summary failed");
      }
      return {
        modelId: "test-model",
        summary: createSummary(article.title),
      };
    });
    const persistence: Persistence = {
      async findArticleByNormalizedUrl() {
        return null;
      },
      async finishFeedJob() {
        return undefined;
      },
      async markArticleFailed(input) {
        failures.push(input);
      },
      async saveArticle(input) {
        savedArticles.push(input);
        return "article-1";
      },
      async startFeedJob() {
        return {
          feedEndpointId: "feed-1",
          jobId: "job-1",
          sourceId: "source-1",
        };
      },
      async updateArticleMetrics() {
        return undefined;
      },
    };

    const resultPromise = runCollector({
      config: {
        ...baseConfig,
        concurrency: 2,
        dryRun: false,
        maxItemsPerFeed: 2,
      },
      dependencies: {
        fetcher: async () => new Response(rss),
        logger: () => undefined,
        persistence,
        summarizer: { summarize },
      },
      feeds: [
        {
          kind: "rss",
          name: "Example",
          siteUrl: "https://example.com",
          url: "https://example.com/feed.xml",
        },
      ],
    });

    await bothSummariesStartedPromise;
    releaseSummaries();
    const result = await resultPromise;

    expect(startedTitles).toHaveLength(2);
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(savedArticles).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(result).toMatchObject({ articleCount: 1, failedCount: 1, successfulFeedCount: 1 });
  });

  it("reports a feed-level failure when the feed cannot be fetched", async () => {
    const finishedJobs: unknown[] = [];
    const persistence: Persistence = {
      async findArticleByNormalizedUrl() {
        return null;
      },
      async finishFeedJob(_jobId, result) {
        finishedJobs.push(result);
      },
      async markArticleFailed() {
        return undefined;
      },
      async saveArticle() {
        throw new Error("saveArticle should not be called");
      },
      async startFeedJob() {
        return {
          feedEndpointId: "feed-1",
          jobId: "job-1",
          sourceId: "source-1",
        };
      },
      async updateArticleMetrics() {
        return undefined;
      },
    };

    const result = await runCollector({
      config: {
        ...baseConfig,
        dryRun: false,
      },
      dependencies: {
        fetcher: async () => {
          throw new Error("feed unavailable");
        },
        logger: () => undefined,
        persistence,
        summarizer: {
          async summarize() {
            throw new Error("summarize should not be called");
          },
        },
      },
      feeds: [
        {
          kind: "rss",
          name: "Example",
          siteUrl: "https://example.com",
          url: "https://example.com/feed.xml",
        },
      ],
    });

    expect(result).toEqual({
      articleCount: 0,
      dryRun: false,
      failedCount: 1,
      failedFeedCount: 1,
      feedCount: 1,
      successfulFeedCount: 0,
    });
    expect(finishedJobs).toEqual([
      {
        errorSummary: "feed unavailable",
        failedCount: 1,
        fetchedCount: 0,
      },
    ]);
  });
});

function createRss(
  items: {
    bookmarks?: number;
    description: string;
    link: string;
    pubDate: string;
    title: string;
  }[],
): string {
  return `<?xml version="1.0" encoding="UTF-8" ?>
<rss version="2.0" xmlns:hatena="http://www.hatena.ne.jp/info/xmlns#">
  <channel>
    ${items
      .map(
        (item) => `<item>
      <title>${item.title}</title>
      <link>${item.link}</link>
      <pubDate>${item.pubDate}</pubDate>
      <description>${item.description}</description>
      <hatena:bookmarkcount>${item.bookmarks ?? 0}</hatena:bookmarkcount>
    </item>`,
      )
      .join("\n")}
  </channel>
</rss>`;
}

function createSummary(title: string) {
  return {
    difficulty: "intermediate" as const,
    importanceScore: 42,
    keyPoints: ["RSSを取得する", "本文をfallbackする", "DBへ保存する"],
    oneLineSummary: `${title} のテスト要約です。`,
    summary: "RSSから取得した本文を使って要約し、保存する経路を検証している。",
    tags: ["TypeScript", "RSS"],
    title,
    whyItMatters: "外部依存を差し替えてcollectorの主要経路を検証できる。",
  };
}

function toUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  return input.url;
}
