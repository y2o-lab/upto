import { calculateTrendScore, normalizeArticleUrl } from "@upto/domain";
import pLimit from "p-limit";

import type { CollectorConfig } from "./config.js";

import { extractArticleContent } from "./content.js";
import { feedEndpointUrl, fetchFeedItems, type FeedItem, type FeedTarget } from "./feeds.js";
import { createPersistence, type ManagedPersistence, type Persistence } from "./persistence.js";
import { createGeminiSummarizer, type Summarizer } from "./summarizer.js";

export type RunCollectorInput = {
  config: CollectorConfig;
  dependencies?: RunCollectorDependencies;
  feeds: FeedTarget[];
};

export type RunCollectorDependencies = {
  createPersistence?: (databaseUrl: string) => ManagedPersistence;
  fetcher?: typeof fetch;
  logger?: (event: Record<string, unknown>) => void;
  persistence?: Persistence;
  summarizer?: Summarizer;
};

export type RunCollectorResult = {
  articleCount: number;
  dryRun: boolean;
  failedCount: number;
  failedFeedCount: number;
  feedCount: number;
  successfulFeedCount: number;
};

export async function runCollector(input: RunCollectorInput): Promise<RunCollectorResult> {
  const logger = input.dependencies?.logger ?? ((event) => console.log(JSON.stringify(event)));

  if (input.config.debug) {
    if (!input.config.databaseUrl && !input.dependencies?.persistence) {
      throw new Error("DATABASE_URL is required when DEBUG=true.");
    }

    const managedPersistence = input.dependencies?.persistence
      ? null
      : (input.dependencies?.createPersistence ?? createPersistence)(
          input.config.databaseUrl ?? "",
        );
    const persistence = input.dependencies?.persistence ?? managedPersistence;

    try {
      if (!persistence?.runInRollbackTransaction) {
        throw new Error("DEBUG=true requires persistence with rollback transaction support.");
      }

      logger({
        debug: true,
        feeds: input.feeds.map((feed) => ({
          endpoint: feedEndpointUrl(feed),
          kind: feed.kind,
          name: feed.name,
        })),
        message:
          "Collector debug mode will roll back all DB writes. External network and LLM requests are skipped.",
      });

      return await persistence.runInRollbackTransaction((transactionalPersistence) =>
        runCollectorWithPersistence({
          config: input.config,
          feeds: input.feeds,
          logger,
          persistence: transactionalPersistence,
          skipExternalRequests: true,
        }),
      );
    } finally {
      await managedPersistence?.close();
    }
  }

  if (input.config.dryRun) {
    logger({
      dryRun: true,
      feeds: input.feeds.map((feed) => ({
        endpoint: feedEndpointUrl(feed),
        kind: feed.kind,
        name: feed.name,
      })),
      message: "Collector dry run completed. No network, LLM, or DB writes were performed.",
    });

    return {
      articleCount: 0,
      dryRun: true,
      failedCount: 0,
      failedFeedCount: 0,
      feedCount: input.feeds.length,
      successfulFeedCount: input.feeds.length,
    };
  }

  if (!input.config.databaseUrl && !input.dependencies?.persistence) {
    throw new Error("DATABASE_URL is required when COLLECTOR_DRY_RUN=false.");
  }

  if (!input.config.geminiApiKey && !input.dependencies?.summarizer) {
    throw new Error("GEMINI_API_KEY is required when COLLECTOR_DRY_RUN=false.");
  }

  const managedPersistence = input.dependencies?.persistence
    ? null
    : (input.dependencies?.createPersistence ?? createPersistence)(input.config.databaseUrl ?? "");
  const persistence = input.dependencies?.persistence ?? managedPersistence;
  if (!persistence) {
    throw new Error("Failed to create collector persistence.");
  }

  try {
    const summarizer =
      input.dependencies?.summarizer ??
      createGeminiSummarizer({
        apiKey: input.config.geminiApiKey ?? "",
        chunkSize: input.config.summaryChunkChars,
        defaultModel: input.config.geminiModelDefault,
        importantModel: input.config.geminiModelImportant,
        maxRetries: input.config.geminiRateLimitMaxRetries,
        requestsPerMinute: input.config.geminiRequestsPerMinute,
        dependencies: {
          onRateLimitWait: ({ maxRequestsPerMinute, waitMilliseconds }) => {
            logger({
              maxRequestsPerMinute,
              status: "gemini_rate_limit_wait",
              waitMilliseconds,
            });
          },
        },
      });
    const fetcher = input.dependencies?.fetcher ?? fetch;
    return await runCollectorWithPersistence({
      config: input.config,
      fetcher,
      feeds: input.feeds,
      logger,
      persistence,
      summarizer,
    });
  } finally {
    await managedPersistence?.close();
  }
}

type RunCollectorWithPersistenceInput = {
  config: CollectorConfig;
  fetcher?: typeof fetch;
  feeds: FeedTarget[];
  logger: (event: Record<string, unknown>) => void;
  persistence: Persistence;
  skipExternalRequests?: boolean;
  summarizer?: Summarizer;
};

async function runCollectorWithPersistence(
  input: RunCollectorWithPersistenceInput,
): Promise<RunCollectorResult> {
  const articleLimit = pLimit(input.config.concurrency);
  let articleCount = 0;
  let failedFeedCount = 0;
  let totalFailedCount = 0;

  for (const feed of input.feeds) {
    const job = await input.persistence.startFeedJob(feed);
    let feedFetchedCount = 0;
    let feedFailedCount = 0;
    let feedFetchFailed = false;
    const feedErrors: string[] = [];

    input.logger({
      endpoint: feedEndpointUrl(feed),
      feed: feed.name,
      jobId: job.jobId,
      status: "started",
    });

    if (input.skipExternalRequests) {
      input.logger({
        feed: feed.name,
        jobId: job.jobId,
        status: "debug_external_requests_skipped",
      });
    } else {
      const { fetcher, summarizer } = input;
      if (!fetcher || !summarizer) {
        throw new Error("Fetcher and summarizer are required outside DEBUG mode.");
      }

      try {
        const items = await fetchFeedItems(feed, input.config.maxItemsPerFeed, fetcher);
        await Promise.all(
          items.map((item) =>
            articleLimit(async () => {
              try {
                const result = await processFeedItem({
                  feed,
                  fetcher,
                  item,
                  logger: input.logger,
                  persistence: input.persistence,
                  sourceId: job.sourceId,
                  summarizer,
                });
                if (result === "processed") {
                  articleCount += 1;
                  feedFetchedCount += 1;
                }
              } catch (error) {
                feedFailedCount += 1;
                const errorMessage = error instanceof Error ? error.message : String(error);
                feedErrors.push(`${item.url}: ${errorMessage}`);
                await markItemFailedIfPossible(input.persistence, job.sourceId, item, error);
                input.logger({
                  error: errorMessage,
                  feed: feed.name,
                  status: "article_failed",
                  url: item.url,
                });
              }
            }),
          ),
        );
      } catch (error) {
        feedFetchFailed = true;
        feedFailedCount += 1;
        const errorMessage = error instanceof Error ? error.message : String(error);
        feedErrors.push(errorMessage);
        input.logger({
          error: errorMessage,
          feed: feed.name,
          status: "feed_failed",
        });
      }
    }

    totalFailedCount += feedFailedCount;
    if (feedFetchFailed) {
      failedFeedCount += 1;
    }
    await input.persistence.finishFeedJob(job.jobId, {
      errorSummary: feedErrors.length > 0 ? feedErrors.slice(0, 10).join("\n") : null,
      failedCount: feedFailedCount,
      fetchedCount: feedFetchedCount,
    });
    input.logger({
      failedCount: feedFailedCount,
      feed: feed.name,
      fetchedCount: feedFetchedCount,
      jobId: job.jobId,
      status: feedFailedCount > 0 ? "finished_with_errors" : "finished",
    });
  }

  return {
    articleCount,
    dryRun: false,
    failedCount: totalFailedCount,
    failedFeedCount,
    feedCount: input.feeds.length,
    successfulFeedCount: input.feeds.length - failedFeedCount,
  };
}

type ProcessFeedItemInput = {
  feed: FeedTarget;
  fetcher: typeof fetch;
  item: FeedItem;
  logger: (event: Record<string, unknown>) => void;
  persistence: Persistence;
  sourceId: string;
  summarizer: Summarizer;
};

type ProcessFeedItemResult = "processed" | "skipped_duplicate";

async function processFeedItem(input: ProcessFeedItemInput): Promise<ProcessFeedItemResult> {
  const normalizedUrl = normalizeArticleUrl(input.item.url);
  const existingArticle = await input.persistence.findArticleByNormalizedUrl(normalizedUrl);
  const score = calculateScoreForItem(input.item);

  if (existingArticle?.summaryStatus === "summarized") {
    try {
      await input.persistence.updateArticleMetrics({
        articleId: existingArticle.id,
        bookmarks: input.item.bookmarks,
        score,
        views: input.item.views,
      });
    } catch (error) {
      input.logger({
        error: error instanceof Error ? error.message : String(error),
        feed: input.feed.name,
        normalizedUrl,
        status: "article_duplicate_metrics_update_failed",
        url: input.item.url,
      });
    }
    input.logger({
      feed: input.feed.name,
      normalizedUrl,
      status: "article_skipped_duplicate",
      url: input.item.url,
    });
    return "skipped_duplicate";
  }

  const content = await extractArticleContent(
    input.item.url,
    input.item.summaryText,
    input.item.contentHtml,
    input.fetcher,
  );

  if (!content.contentText) {
    throw new Error("No article content was available after extraction and fallback.");
  }

  const summary = await input.summarizer.summarize({
    bookmarks: input.item.bookmarks,
    contentText: content.contentText,
    publishedAt: input.item.publishedAt,
    sourceName: input.feed.name,
    title: input.item.title,
    url: input.item.url,
    views: input.item.views,
  });
  await input.persistence.saveArticle({
    content,
    item: input.item,
    modelId: summary.modelId,
    normalizedUrl,
    score,
    sourceId: input.sourceId,
    summary: summary.summary,
  });

  return "processed";
}

function calculateScoreForItem(item: FeedItem): number {
  const ageHours = item.publishedAt
    ? Math.max(0, (Date.now() - item.publishedAt.getTime()) / 3_600_000)
    : 0;
  return calculateTrendScore({
    ageHours,
    bookmarks: item.bookmarks,
    views: item.views,
  });
}

async function markItemFailedIfPossible(
  persistence: Persistence,
  sourceId: string,
  item: FeedItem,
  error: unknown,
): Promise<void> {
  try {
    await persistence.markArticleFailed({
      error,
      item,
      normalizedUrl: normalizeArticleUrl(item.url),
      sourceId,
    });
  } catch {
    // If the URL itself is invalid, the crawl job error summary is the durable record.
  }
}
