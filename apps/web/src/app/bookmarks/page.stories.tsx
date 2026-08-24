import type { FeedArticle } from "../../lib/articles";

import { ArticleFeed } from "../../components/article-feed";

const articles = [
  {
    bookmarks: 24,
    difficulty: "intermediate",
    id: "00000000-0000-4000-8000-000000000101",
    modelId: "storybook",
    normalizedUrl: "https://example.com/articles/bookmark",
    oneLineSummary: "保存した記事の一覧を確認するためのサンプルです。",
    originalUrl: "https://example.com/articles/bookmark",
    publishedAt: new Date("2026-06-13T02:00:00.000Z").toISOString(),
    score: 72,
    sourceId: "00000000-0000-4000-8000-100000000101",
    sourceName: "Upto News",
    sourceSiteUrl: "https://example.com",
    summary: "保存した記事も通常のフィードと同じ読み心地で確認できます。",
    summaryBullets: ["保存した記事をすぐに開ける"],
    tags: ["Bookmark"],
    title: "保存記事をあとで読む",
    views: 430,
    whyItMatters: "気になる記事を読み逃さずに済みます。",
  },
] satisfies FeedArticle[];

function BookmarksPagePreview() {
  return <ArticleFeed articles={articles} feedType="bookmarks" />;
}

export default {
  title: "Pages/Bookmarks",
  component: BookmarksPagePreview,
  parameters: {
    layout: "fullscreen",
  },
};

export const Default = {};

export const Empty = {
  render: () => <ArticleFeed articles={[]} emptyState="saved" feedType="bookmarks" />,
};
