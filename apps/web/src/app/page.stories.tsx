import { useState } from "react";

import type { FeedArticle } from "../lib/articles";

import { ArticleFeed } from "../components/article-feed";
import ErrorPage from "./error";
import LoadingPage from "./loading";

const articles = [
  {
    bookmarks: 24,
    difficulty: "intermediate",
    id: "00000000-0000-4000-8000-000000000101",
    modelId: "storybook",
    normalizedUrl: "https://example.com/articles/storybook-page",
    oneLineSummary: "Storybook 上でページ相当のニュースフィードを確認するためのサンプルです。",
    originalUrl: "https://example.com/articles/storybook-page",
    publishedAt: new Date("2026-06-13T02:00:00.000Z").toISOString(),
    score: 72,
    sourceId: "00000000-0000-4000-8000-100000000101",
    sourceName: "Upto News",
    sourceSiteUrl: "https://example.com",
    summary:
      "DB 接続を使う Server Component を直接 Storybook に載せず、ページと同じフィード構成を固定データで確認します。",
    summaryBullets: [
      "デプロイ前に UI の見た目を確認できる",
      "DB 接続なしでフィード操作を試せる",
      "GitHub Actions から静的 Storybook を公開する",
    ],
    tags: ["Storybook", "Next.js", "CI"],
    title: "Storybook でニュースフィード画面を確認する",
    views: 430,
    whyItMatters: "ページの見た目と操作を、アプリ本体のデプロイ前にレビューできます。",
  },
] satisfies FeedArticle[];

function HomePagePreview() {
  return (
    <main>
      <ArticleFeed articles={articles} />
    </main>
  );
}

function HomeErrorPreview() {
  const [hasError, setHasError] = useState(true);
  return hasError ? (
    <ErrorPage
      error={new globalThis.Error("Storybook: initial article load failed")}
      reset={() => setHasError(false)}
    />
  ) : (
    <HomePagePreview />
  );
}

export default {
  title: "Pages/Home",
  component: HomePagePreview,
  parameters: {
    layout: "fullscreen",
  },
};

export const Default = {};

export const Empty = {
  render: () => (
    <main>
      <ArticleFeed articles={[]} />
    </main>
  ),
};

export const Loading = {
  render: () => <LoadingPage />,
};

export const Error = {
  render: () => <HomeErrorPreview />,
};
