import type { ArticleSummary } from "@upto/domain";

import {
  articleContents,
  articleMetrics,
  articles,
  articleSummaries,
  closeDb,
  createDb,
  crawlJobs,
  eq,
  feedEndpoints,
  sql,
  sources,
  type DbClient,
} from "@upto/db";

import type { ExtractedContent } from "./content.js";

import { feedEndpointUrl, type FeedItem, type FeedTarget } from "./feeds.js";

export type FeedJob = {
  feedEndpointId: string;
  jobId: string;
  sourceId: string;
};

export type ExistingArticle = {
  id: string;
  summaryStatus: "failed" | "pending" | "summarized";
};

export type SaveArticleInput = {
  content: ExtractedContent;
  item: FeedItem;
  modelId: string;
  normalizedUrl: string;
  score: number;
  sourceId: string;
  summary: ArticleSummary;
};

export type Persistence = {
  findArticleByNormalizedUrl(normalizedUrl: string): Promise<ExistingArticle | null>;
  finishFeedJob(jobId: string, result: FinishFeedJobInput): Promise<void>;
  markArticleFailed(input: MarkArticleFailedInput): Promise<void>;
  saveArticle(input: SaveArticleInput): Promise<string>;
  startFeedJob(feed: FeedTarget): Promise<FeedJob>;
  updateArticleMetrics(input: UpdateArticleMetricsInput): Promise<void>;
};

export type ManagedPersistence = Persistence & {
  close(): Promise<void>;
};

export type FinishFeedJobInput = {
  errorSummary: string | null;
  failedCount: number;
  fetchedCount: number;
};

export type MarkArticleFailedInput = {
  error: unknown;
  item: FeedItem;
  normalizedUrl: string;
  sourceId: string;
};

export type UpdateArticleMetricsInput = {
  articleId: string;
  bookmarks: number;
  score: number;
  views: number;
};

export function createPersistence(databaseUrl: string): ManagedPersistence {
  return new DbPersistence(createDb(databaseUrl));
}

class DbPersistence implements Persistence {
  constructor(private readonly db: DbClient) {}

  async close(): Promise<void> {
    await closeDb(this.db);
  }

  async startFeedJob(feed: FeedTarget): Promise<FeedJob> {
    const sourceId = await this.findOrCreateSource(feed.name, feed.siteUrl);
    const feedEndpointId = await this.upsertFeedEndpoint(sourceId, feedEndpointUrl(feed));
    const [job] = await this.db
      .insert(crawlJobs)
      .values({
        feedEndpointId,
        status: "running",
      })
      .returning({
        id: crawlJobs.id,
      });

    if (!job) {
      throw new Error(`Failed to create crawl job for ${feed.name}.`);
    }

    return {
      feedEndpointId,
      jobId: job.id,
      sourceId,
    };
  }

  async findArticleByNormalizedUrl(normalizedUrl: string): Promise<ExistingArticle | null> {
    const [article] = await this.db
      .select({
        id: articles.id,
        summaryStatus: articles.summaryStatus,
      })
      .from(articles)
      .where(eq(articles.normalizedUrl, normalizedUrl))
      .limit(1);

    return article ?? null;
  }

  async saveArticle(input: SaveArticleInput): Promise<string> {
    const now = new Date();
    const [article] = await this.db
      .insert(articles)
      .values({
        fetchStatus: input.content.status === "failed" ? "failed" : "fetched",
        normalizedUrl: input.normalizedUrl,
        originalUrl: input.item.url,
        publishedAt: input.item.publishedAt,
        sourceId: input.sourceId,
        summaryStatus: "summarized",
        title: input.summary.title || input.item.title,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        set: {
          fetchStatus: input.content.status === "failed" ? "failed" : "fetched",
          originalUrl: input.item.url,
          publishedAt: input.item.publishedAt,
          sourceId: input.sourceId,
          summaryStatus: "summarized",
          title: input.summary.title || input.item.title,
          updatedAt: now,
        },
        target: articles.normalizedUrl,
      })
      .returning({
        id: articles.id,
      });

    if (!article) {
      throw new Error(`Failed to save article ${input.item.url}.`);
    }

    await this.db
      .insert(articleContents)
      .values({
        articleId: article.id,
        contentHtml: input.content.contentHtml,
        contentText: input.content.contentText,
        extractedAt: now,
      })
      .onConflictDoUpdate({
        set: {
          contentHtml: input.content.contentHtml,
          contentText: input.content.contentText,
          extractedAt: now,
        },
        target: articleContents.articleId,
      });

    await this.db
      .insert(articleSummaries)
      .values({
        articleId: article.id,
        bullets: input.summary.keyPoints,
        modelId: input.modelId,
        shortSummary: input.summary.oneLineSummary,
        summarizedAt: now,
        summaryJson: serializeSummary(input.summary),
        topics: input.summary.tags,
      })
      .onConflictDoUpdate({
        set: {
          bullets: input.summary.keyPoints,
          modelId: input.modelId,
          shortSummary: input.summary.oneLineSummary,
          summarizedAt: now,
          summaryJson: serializeSummary(input.summary),
          topics: input.summary.tags,
        },
        target: articleSummaries.articleId,
      });

    await this.db
      .insert(articleMetrics)
      .values({
        articleId: article.id,
        bookmarks: input.item.bookmarks,
        measuredAt: now,
        score: Math.round(input.score),
        views: input.item.views,
      })
      .onConflictDoUpdate({
        set: {
          bookmarks: input.item.bookmarks,
          measuredAt: now,
          score: Math.round(input.score),
          views: input.item.views,
        },
        target: articleMetrics.articleId,
      });

    return article.id;
  }

  async updateArticleMetrics(input: UpdateArticleMetricsInput): Promise<void> {
    const now = new Date();
    await this.db
      .insert(articleMetrics)
      .values({
        articleId: input.articleId,
        bookmarks: input.bookmarks,
        measuredAt: now,
        score: Math.round(input.score),
        views: input.views,
      })
      .onConflictDoUpdate({
        set: {
          bookmarks: input.bookmarks,
          measuredAt: now,
          score: Math.round(input.score),
          views: input.views,
        },
        target: articleMetrics.articleId,
      });
  }

  async markArticleFailed(input: MarkArticleFailedInput): Promise<void> {
    const now = new Date();
    await this.db
      .insert(articles)
      .values({
        fetchStatus: "failed",
        normalizedUrl: input.normalizedUrl,
        originalUrl: input.item.url,
        publishedAt: input.item.publishedAt,
        retryCount: 1,
        sourceId: input.sourceId,
        summaryStatus: "failed",
        title: input.item.title,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        set: {
          fetchStatus: "failed",
          retryCount: sql`${articles.retryCount} + 1`,
          summaryStatus: "failed",
          updatedAt: now,
        },
        target: articles.normalizedUrl,
      });
  }

  async finishFeedJob(jobId: string, result: FinishFeedJobInput): Promise<void> {
    await this.db
      .update(crawlJobs)
      .set({
        errorSummary: result.errorSummary,
        failedCount: result.failedCount,
        fetchedCount: result.fetchedCount,
        finishedAt: new Date(),
        status: result.failedCount > 0 ? "failed" : "succeeded",
      })
      .where(eq(crawlJobs.id, jobId));
  }

  private async findOrCreateSource(name: string, siteUrl: string): Promise<string> {
    const [source] = await this.db
      .insert(sources)
      .values({
        name,
        siteUrl,
      })
      .onConflictDoUpdate({
        set: {
          siteUrl,
        },
        target: sources.name,
      })
      .returning({
        id: sources.id,
      });

    if (!source) {
      throw new Error(`Failed to create source ${name}.`);
    }

    return source.id;
  }

  private async upsertFeedEndpoint(sourceId: string, url: string): Promise<string> {
    const [endpoint] = await this.db
      .insert(feedEndpoints)
      .values({
        sourceId,
        url,
      })
      .onConflictDoUpdate({
        set: {
          sourceId,
        },
        target: feedEndpoints.url,
      })
      .returning({
        id: feedEndpoints.id,
      });

    if (!endpoint) {
      throw new Error(`Failed to create feed endpoint ${url}.`);
    }

    return endpoint.id;
  }
}

export function serializeSummary(summary: ArticleSummary): Record<string, unknown> {
  return {
    difficulty: summary.difficulty,
    importance_score: summary.importanceScore,
    key_points: summary.keyPoints,
    one_line_summary: summary.oneLineSummary,
    summary: summary.summary,
    tags: summary.tags,
    title: summary.title,
    why_it_matters: summary.whyItMatters,
  };
}
