import { relations } from "drizzle-orm";
import {
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const crawlJobStatus = pgEnum("crawl_job_status", ["running", "succeeded", "failed"]);
export const articleFetchStatus = pgEnum("article_fetch_status", ["pending", "fetched", "failed"]);
export const articleSummaryStatus = pgEnum("article_summary_status", [
  "pending",
  "summarized",
  "failed",
]);

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    siteUrl: text("site_url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("sources_name_unique").on(table.name)],
);

export const feedEndpoints = pgTable(
  "feed_endpoints",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex("feed_endpoints_url_unique").on(table.url)],
);

export const crawlJobs = pgTable(
  "crawl_jobs",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    feedEndpointId: uuid("feed_endpoint_id").references(() => feedEndpoints.id, {
      onDelete: "set null",
    }),
    status: crawlJobStatus("status").default("running").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    fetchedCount: integer("fetched_count").default(0).notNull(),
    failedCount: integer("failed_count").default(0).notNull(),
    errorSummary: text("error_summary"),
  },
  (table) => [index("crawl_jobs_status_started_at_idx").on(table.status, table.startedAt)],
);

export const articles = pgTable(
  "articles",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    sourceId: uuid("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "restrict" }),
    title: text("title").notNull(),
    originalUrl: text("original_url").notNull(),
    normalizedUrl: text("normalized_url").notNull(),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    fetchStatus: articleFetchStatus("fetch_status").default("pending").notNull(),
    summaryStatus: articleSummaryStatus("summary_status").default("pending").notNull(),
    retryCount: integer("retry_count").default(0).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("articles_normalized_url_unique").on(table.normalizedUrl),
    index("articles_created_at_idx").on(table.createdAt),
    index("articles_published_at_idx").on(table.publishedAt),
    index("articles_source_id_idx").on(table.sourceId),
  ],
);

export const articleContents = pgTable("article_contents", {
  articleId: uuid("article_id")
    .primaryKey()
    .references(() => articles.id, { onDelete: "cascade" }),
  contentText: text("content_text"),
  contentHtml: text("content_html"),
  extractedAt: timestamp("extracted_at", { withTimezone: true }).defaultNow().notNull(),
});

export const articleSummaries = pgTable("article_summaries", {
  articleId: uuid("article_id")
    .primaryKey()
    .references(() => articles.id, { onDelete: "cascade" }),
  modelId: text("model_id").notNull(),
  shortSummary: text("short_summary").notNull(),
  bullets: jsonb("bullets").$type<string[]>().notNull(),
  topics: jsonb("topics").$type<string[]>().default([]).notNull(),
  summaryJson: jsonb("summary_json").$type<Record<string, unknown>>().default({}).notNull(),
  summarizedAt: timestamp("summarized_at", { withTimezone: true }).defaultNow().notNull(),
});

export const articleMetrics = pgTable(
  "article_metrics",
  {
    articleId: uuid("article_id")
      .primaryKey()
      .references(() => articles.id, { onDelete: "cascade" }),
    bookmarks: integer("bookmarks").default(0).notNull(),
    views: integer("views").default(0).notNull(),
    score: integer("score").default(0).notNull(),
    measuredAt: timestamp("measured_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("article_metrics_score_idx").on(table.score)],
);

export const sourcesRelations = relations(sources, ({ many }) => ({
  articles: many(articles),
  feedEndpoints: many(feedEndpoints),
}));

export const articlesRelations = relations(articles, ({ one }) => ({
  content: one(articleContents, {
    fields: [articles.id],
    references: [articleContents.articleId],
  }),
  metrics: one(articleMetrics, {
    fields: [articles.id],
    references: [articleMetrics.articleId],
  }),
  source: one(sources, {
    fields: [articles.sourceId],
    references: [sources.id],
  }),
  summary: one(articleSummaries, {
    fields: [articles.id],
    references: [articleSummaries.articleId],
  }),
}));
