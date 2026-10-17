import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";

import type { FeedArticle } from "../lib/articles";

import { ArticleFeed } from "../components/article-feed";
import { readyFeed } from "../test/storybook";
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
      retry={() => setHasError(false)}
    />
  ) : (
    <HomePagePreview />
  );
}

const meta = {
  title: "Pages/Home",
  component: HomePagePreview,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof HomePagePreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await readyFeed(canvasElement);
    const card = within(canvas.getByTestId("article-card-0"));
    await expect(card.getByRole("heading", { name: articles[0]!.title })).toBeVisible();
    await expect(card.getByText(articles[0]!.oneLineSummary!)).toBeVisible();
    for (const bullet of articles[0]!.summaryBullets) {
      await expect(card.getByText(bullet)).toBeVisible();
    }
    const link = card.getByRole("link", { name: "元記事を読む" });
    await expect(link).toHaveAttribute("href", articles[0]!.originalUrl);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noreferrer");
  },
};

export const Empty: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      await canvas.findByRole("heading", { name: "今日の新着は以上です" }),
    ).toBeVisible();
    await expect(canvas.getByRole("heading", { name: "Upto" })).toBeVisible();
    await expect(canvas.queryByTestId("article-feed")).not.toBeInTheDocument();
  },
  render: () => (
    <main>
      <ArticleFeed articles={[]} />
    </main>
  ),
};

export const Loading: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("loading")).toBeVisible();
    await expect(canvas.queryByTestId("article-feed")).not.toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "再試行" })).not.toBeInTheDocument();
  },
  render: () => <LoadingPage />,
};

export const Error: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByRole("heading", { name: "記事を読み込めませんでした" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "再読み込み" }));
    await readyFeed(canvasElement);
    await expect(canvas.getByRole("heading", { name: articles[0]!.title })).toBeVisible();
    await expect(
      canvas.queryByRole("heading", { name: "記事を読み込めませんでした" }),
    ).not.toBeInTheDocument();
  },
  render: () => <HomeErrorPreview />,
};
