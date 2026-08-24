import type { Article } from "@upto/domain";

import {
  articleMetrics,
  articles,
  articleSummaries,
  desc,
  eq,
  getDb,
  inArray,
  sources,
  sql,
} from "@upto/db";
import { z } from "zod";

export type FeedArticle = Article & {
  bookmarks: number;
  difficulty: "beginner" | "intermediate" | "advanced";
  modelId: string;
  oneLineSummary: string | null;
  sourceName: string;
  sourceSiteUrl: string;
  tags: string[];
  views: number;
  whyItMatters: string | null;
};

type ArticleRow = {
  bookmarks: number | null;
  bullets: string[];
  createdAt: Date;
  id: string;
  modelId: string;
  normalizedUrl: string;
  originalUrl: string;
  publishedAt: Date | null;
  score: number | null;
  shortSummary: string;
  sourceId: string;
  sourceName: string;
  sourceSiteUrl: string;
  summaryJson: Record<string, unknown>;
  title: string;
  topics: string[];
  views: number | null;
};

type ArticlePageCursor = {
  createdAt: string;
  id: string;
  publishedAt: string | null;
  score: number;
};

export type ArticlePage = {
  articles: FeedArticle[];
  hasMore: boolean;
  nextCursor: string | null;
  /**
   * Feed session anchor. MVP freezes article membership with articles.createdAt <= snapshotAt.
   * Score changes can still affect ordering until score history or materialized feed sessions exist.
   */
  snapshotAt: string;
};

const defaultPageLimit = 10;
const maxPageLimit = 30;

const articlePageCursorSchema = z.object({
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
  publishedAt: z.string().datetime().nullable(),
  score: z.number().finite(),
});

const articlePageSnapshotAtSchema = z.string().datetime();

const fixtureRows: ArticleRow[] = [
  {
    bookmarks: 42,
    bullets: [
      "初期表示は Server Component で取得する",
      "カード遷移は Client Component に閉じ込める",
      "追加取得は cursor pagination で拡張する",
    ],
    createdAt: new Date("2026-06-07T03:00:00.000Z"),
    id: "00000000-0000-4000-8000-000000000001",
    modelId: "fixture",
    normalizedUrl: "https://zenn.dev/example/articles/next-news",
    originalUrl: "https://zenn.dev/example/articles/next-news",
    publishedAt: new Date("2026-06-07T00:00:00.000Z"),
    score: 83,
    sourceId: "00000000-0000-4000-8000-100000000001",
    sourceName: "Zenn",
    sourceSiteUrl: "https://zenn.dev",
    shortSummary:
      "Next.js App Router と Server Components を土台に、初期表示を軽く保ちながら縦スワイプ型ニュースフィードを構成する実装例です。カード遷移はClient Componentに閉じ込め、データ取得はサーバー側に寄せています。",
    summaryJson: {
      difficulty: "intermediate",
      one_line_summary: "Next.js App Router と Server Components を活用した記事配信の実装例です。",
      summary:
        "Next.js App Router と Server Components を土台に、初期表示を軽く保ちながら縦スワイプ型ニュースフィードを構成する実装例です。カード遷移はClient Componentに閉じ込め、データ取得はサーバー側に寄せています。",
      tags: ["Next.js", "React", "UI"],
      why_it_matters:
        "サーバー取得とクライアント操作の責務を分けることで、MVPでも拡張しやすいUIを作れます。",
    },
    title: "Next.js で縦スワイプ型ニュース UI を作る",
    topics: ["Next.js", "React", "UI"],
    views: 820,
  },
  {
    bookmarks: 31,
    bullets: [
      "crawl_jobs に実行状態を保存する",
      "記事単位の失敗を retry_count で管理する",
      "Gemini の rate limit を concurrency で制御する",
    ],
    createdAt: new Date("2026-06-07T02:00:00.000Z"),
    id: "00000000-0000-4000-8000-000000000002",
    modelId: "fixture",
    normalizedUrl: "https://qiita.com/example/items/collector",
    originalUrl: "https://qiita.com/example/items/collector",
    publishedAt: new Date("2026-06-07T01:00:00.000Z"),
    score: 61,
    sourceId: "00000000-0000-4000-8000-100000000002",
    sourceName: "Qiita",
    sourceSiteUrl: "https://qiita.com",
    shortSummary:
      "ニュース収集バッチをidempotentに動かすため、crawl_jobs と記事単位のステータスで実行結果を記録します。本文抽出や要約で失敗しても、他の記事の処理を続けられる設計です。",
    summaryJson: {
      difficulty: "beginner",
      one_line_summary: "RSS 取得、本文抽出、LLM 要約を安全に進めるためのバッチ設計です。",
      summary:
        "ニュース収集バッチをidempotentに動かすため、crawl_jobs と記事単位のステータスで実行結果を記録します。本文抽出や要約で失敗しても、他の記事の処理を続けられる設計です。",
      tags: ["Batch", "PostgreSQL", "Gemini"],
      why_it_matters:
        "外部APIとLLMを扱うバッチでは、部分失敗を前提にした永続化が運用安定性に直結します。",
    },
    title: "ニュース収集バッチを安全に設計する",
    topics: ["Batch", "PostgreSQL", "Gemini"],
    views: 510,
  },
  ...Array.from({ length: 10 }, (_, index) =>
    createFixtureRow({
      idNumber: index + 3,
      publishedAt: new Date(`2026-06-06T${String(23 - index).padStart(2, "0")}:00:00.000Z`),
      score: 58 - index * 3,
      sourceName: index % 2 === 0 ? "Hatena" : "GitHub Blog",
      title: `fixture pagination article ${index + 3}`,
    }),
  ),
];

const fixtureArticles = fixtureRows.map(mapArticleRow);

export async function getArticlesPage(
  input: {
    cursor?: string | null;
    limit?: number;
    snapshotAt?: string | null;
  } = {},
): Promise<ArticlePage> {
  const limit = normalizeArticlePageLimit(input.limit);
  const cursor = input.cursor ? decodeArticlePageCursor(input.cursor) : null;
  const snapshotAt = normalizeArticlePageSnapshotAt(input.snapshotAt);

  if (process.env.UPTO_WEB_USE_FIXTURE_DATA === "true") {
    return paginateRows(fixtureRows, { cursor, limit, snapshotAt });
  }

  const db = getDb();
  const rows = await db
    .select({
      bookmarks: articleMetrics.bookmarks,
      bullets: articleSummaries.bullets,
      createdAt: articles.createdAt,
      id: articles.id,
      modelId: articleSummaries.modelId,
      normalizedUrl: articles.normalizedUrl,
      originalUrl: articles.originalUrl,
      publishedAt: articles.publishedAt,
      score: articleMetrics.score,
      shortSummary: articleSummaries.shortSummary,
      sourceId: articles.sourceId,
      sourceName: sources.name,
      sourceSiteUrl: sources.siteUrl,
      summaryJson: articleSummaries.summaryJson,
      title: articles.title,
      topics: articleSummaries.topics,
      views: articleMetrics.views,
    })
    .from(articles)
    .innerJoin(sources, eq(articles.sourceId, sources.id))
    .innerJoin(articleSummaries, eq(articles.id, articleSummaries.articleId))
    .leftJoin(articleMetrics, eq(articles.id, articleMetrics.articleId))
    .where(buildArticlePageWhere({ cursor, snapshotAt: new Date(snapshotAt) }))
    .orderBy(
      sql`coalesce(${articleMetrics.score}, 0) desc`,
      sql`${articles.publishedAt} desc nulls last`,
      desc(articles.createdAt),
      desc(articles.id),
    )
    .limit(limit + 1);

  return paginateRows(rows, { limit, snapshotAt });
}

export async function getInitialArticles(limit = defaultPageLimit): Promise<FeedArticle[]> {
  const page = await getArticlesPage({ limit });
  return page.articles;
}

export async function getArticlesByIds(articleIds: string[]): Promise<FeedArticle[]> {
  const uniqueArticleIds = [...new Set(articleIds)];
  if (uniqueArticleIds.length === 0) {
    return [];
  }

  if (process.env.UPTO_WEB_USE_FIXTURE_DATA === "true") {
    return orderArticlesByIds(fixtureArticles, uniqueArticleIds);
  }

  const db = getDb();
  const rows = await db
    .select({
      bookmarks: articleMetrics.bookmarks,
      bullets: articleSummaries.bullets,
      createdAt: articles.createdAt,
      id: articles.id,
      modelId: articleSummaries.modelId,
      normalizedUrl: articles.normalizedUrl,
      originalUrl: articles.originalUrl,
      publishedAt: articles.publishedAt,
      score: articleMetrics.score,
      shortSummary: articleSummaries.shortSummary,
      sourceId: articles.sourceId,
      sourceName: sources.name,
      sourceSiteUrl: sources.siteUrl,
      summaryJson: articleSummaries.summaryJson,
      title: articles.title,
      topics: articleSummaries.topics,
      views: articleMetrics.views,
    })
    .from(articles)
    .innerJoin(sources, eq(articles.sourceId, sources.id))
    .innerJoin(articleSummaries, eq(articles.id, articleSummaries.articleId))
    .leftJoin(articleMetrics, eq(articles.id, articleMetrics.articleId))
    .where(inArray(articles.id, uniqueArticleIds));

  return orderArticlesByIds(rows.map(mapArticleRow), uniqueArticleIds);
}

export function mapArticleRow(row: ArticleRow): FeedArticle {
  const summary = readString(row.summaryJson.summary) ?? row.shortSummary;
  const oneLineSummary = readString(row.summaryJson.one_line_summary) ?? row.shortSummary;
  const tags = readStringArray(row.summaryJson.tags);

  return {
    bookmarks: row.bookmarks ?? 0,
    difficulty: readDifficulty(row.summaryJson.difficulty),
    id: row.id,
    modelId: row.modelId,
    normalizedUrl: row.normalizedUrl,
    oneLineSummary,
    originalUrl: row.originalUrl,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    score: row.score ?? 0,
    sourceId: row.sourceId,
    sourceName: row.sourceName,
    sourceSiteUrl: row.sourceSiteUrl,
    summary,
    summaryBullets:
      row.bullets.length > 0 ? row.bullets : readStringArray(row.summaryJson.key_points),
    tags: tags.length > 0 ? tags : row.topics,
    title: readString(row.summaryJson.title) ?? row.title,
    views: row.views ?? 0,
    whyItMatters: readString(row.summaryJson.why_it_matters),
  };
}

function createFixtureRow(input: {
  idNumber: number;
  publishedAt: Date | null;
  score: number;
  sourceName: string;
  title: string;
}): ArticleRow {
  const id = `00000000-0000-4000-8000-${String(input.idNumber).padStart(12, "0")}`;

  return {
    bookmarks: Math.max(5, input.score - 10),
    bullets: [
      "追加ページでもカード遷移を維持する",
      "fixture mode でページングを検証する",
      "終端表示は hasMore=false まで出さない",
    ],
    createdAt: new Date(`2026-06-06T${String(20 - input.idNumber).padStart(2, "0")}:30:00.000Z`),
    id,
    modelId: "fixture",
    normalizedUrl: `https://example.com/articles/${input.idNumber}`,
    originalUrl: `https://example.com/articles/${input.idNumber}`,
    publishedAt: input.publishedAt,
    score: input.score,
    shortSummary:
      "記事フィードの追加読み込み、閲覧位置、キーボード操作をまとめて確認するためのfixture記事です。",
    sourceId: "00000000-0000-4000-8000-100000000003",
    sourceName: input.sourceName,
    sourceSiteUrl: "https://example.com",
    summaryJson: {
      difficulty: input.idNumber % 3 === 0 ? "advanced" : "intermediate",
      one_line_summary: "cursor pagination の検証用に追加したfixture記事です。",
      summary:
        "初期ページの後続データとして返され、Client Component が終端付近で追加取得できることを確認します。",
      tags: ["Pagination", "Fixture", "Next.js"],
      why_it_matters:
        "固定データでも追加読み込みの成功、失敗、終端を検証できるため、DB状態に依存しないE2Eが書けます。",
    },
    title: input.title,
    topics: ["Pagination", "Fixture", "Next.js"],
    views: input.score * 8,
  };
}

function paginateRows(
  rows: ArticleRow[],
  input: { cursor?: ArticlePageCursor | null; limit: number; snapshotAt: string },
): ArticlePage {
  const snapshotTime = new Date(input.snapshotAt).getTime();
  const sessionRows = rows.filter((row) => row.createdAt.getTime() <= snapshotTime);
  const filteredRows = input.cursor
    ? sessionRows.filter((row) => isRowAfterCursor(row, input.cursor as ArticlePageCursor))
    : sessionRows;
  const requestedRows = filteredRows.slice(0, input.limit + 1);
  const articleRows = requestedRows.slice(0, input.limit);
  const hasMore = requestedRows.length > input.limit;
  const lastRow = articleRows.at(-1);

  return {
    articles: articleRows.map(mapArticleRow),
    hasMore,
    nextCursor: hasMore && lastRow ? encodeArticlePageCursor(createCursorFromRow(lastRow)) : null,
    snapshotAt: input.snapshotAt,
  };
}

function orderArticlesByIds(articleList: FeedArticle[], articleIds: string[]): FeedArticle[] {
  const articlesById = new Map(articleList.map((article) => [article.id, article]));
  return articleIds.flatMap((articleId) => {
    const article = articlesById.get(articleId);
    return article ? [article] : [];
  });
}

function normalizeArticlePageLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) {
    return defaultPageLimit;
  }

  return Math.max(1, Math.min(maxPageLimit, Math.trunc(limit as number)));
}

function encodeArticlePageCursor(cursor: ArticlePageCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decodeArticlePageCursor(value: string): ArticlePageCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    return articlePageCursorSchema.parse(decoded);
  } catch {
    throw new Error("Invalid article page cursor");
  }
}

function normalizeArticlePageSnapshotAt(value: string | null | undefined): string {
  if (!value) {
    return new Date().toISOString();
  }

  try {
    return articlePageSnapshotAtSchema.parse(value);
  } catch {
    throw new Error("Invalid article page snapshot");
  }
}

function createCursorFromRow(row: ArticleRow): ArticlePageCursor {
  return {
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    score: row.score ?? 0,
  };
}

function isRowAfterCursor(row: ArticleRow, cursor: ArticlePageCursor): boolean {
  const rowCursor = createCursorFromRow(row);

  if (rowCursor.score !== cursor.score) {
    return rowCursor.score < cursor.score;
  }

  const publishedComparison = comparePublishedAtDescNullsLast(
    rowCursor.publishedAt,
    cursor.publishedAt,
  );
  if (publishedComparison !== 0) {
    return publishedComparison > 0;
  }

  if (rowCursor.createdAt !== cursor.createdAt) {
    return rowCursor.createdAt < cursor.createdAt;
  }

  return rowCursor.id < cursor.id;
}

function comparePublishedAtDescNullsLast(left: string | null, right: string | null): number {
  if (left === right) {
    return 0;
  }

  if (left === null) {
    return 1;
  }

  if (right === null) {
    return -1;
  }

  return left < right ? 1 : -1;
}

function buildArticlePageWhere(input: { cursor: ArticlePageCursor | null; snapshotAt: Date }) {
  const { cursor, snapshotAt } = input;

  if (!cursor) {
    return sql`
      ${articles.summaryStatus} = 'summarized'
      and ${articles.createdAt} <= ${snapshotAt}
    `;
  }

  const publishedAt = cursor.publishedAt ? new Date(cursor.publishedAt) : null;
  const createdAt = new Date(cursor.createdAt);

  if (publishedAt) {
    return sql`
      ${articles.summaryStatus} = 'summarized'
      and ${articles.createdAt} <= ${snapshotAt}
      and (
        coalesce(${articleMetrics.score}, 0) < ${cursor.score}
        or (
          coalesce(${articleMetrics.score}, 0) = ${cursor.score}
          and (
            ${articles.publishedAt} < ${publishedAt}
            or ${articles.publishedAt} is null
            or (
              ${articles.publishedAt} = ${publishedAt}
              and (
                ${articles.createdAt} < ${createdAt}
                or (${articles.createdAt} = ${createdAt} and ${articles.id} < ${cursor.id})
              )
            )
          )
        )
      )
    `;
  }

  return sql`
    ${articles.summaryStatus} = 'summarized'
    and ${articles.createdAt} <= ${snapshotAt}
    and (
      coalesce(${articleMetrics.score}, 0) < ${cursor.score}
      or (
        coalesce(${articleMetrics.score}, 0) = ${cursor.score}
        and ${articles.publishedAt} is null
        and (
          ${articles.createdAt} < ${createdAt}
          or (${articles.createdAt} = ${createdAt} and ${articles.id} < ${cursor.id})
        )
      )
    )
  `;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function readDifficulty(value: unknown): FeedArticle["difficulty"] {
  if (value === "beginner" || value === "advanced") {
    return value;
  }

  return "intermediate";
}

export async function getFixtureArticlesForTest(): Promise<FeedArticle[]> {
  return [...fixtureArticles];
}
