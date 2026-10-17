import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { useState } from "react";
import { expect, userEvent, within } from "storybook/test";

import type { FeedArticle } from "../../lib/articles";

import { ArticleFeed } from "../../components/article-feed";
import { readyFeed } from "../../test/storybook";

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

function BookmarksErrorPreview() {
  const [hasError, setHasError] = useState(true);
  return hasError ? (
    <ArticleFeed
      articles={[]}
      emptyState="saved"
      feedType="bookmarks"
      loadError="保存した記事の取得に失敗しました"
      onRetry={() => setHasError(false)}
    />
  ) : (
    <BookmarksPagePreview />
  );
}

const meta = {
  title: "Pages/Bookmarks",
  component: BookmarksPagePreview,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta<typeof BookmarksPagePreview>;

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
      await canvas.findByRole("heading", { name: "保存した記事はありません" }),
    ).toBeVisible();
    await expect(canvas.getByRole("heading", { name: "Upto" })).toBeVisible();
    await expect(canvas.queryByTestId("article-feed")).not.toBeInTheDocument();
    await expect(
      canvas.getByText("記事の☆を選択すると、あとでここからまとめて読めます。"),
    ).toBeVisible();
  },
  render: () => <ArticleFeed articles={[]} emptyState="saved" feedType="bookmarks" />,
};

export const Loading: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "保存した記事を読み込んでいます" }),
    ).toBeVisible();
    await expect(canvas.queryByTestId("article-feed")).not.toBeInTheDocument();
    await expect(canvas.queryByRole("button", { name: "再試行" })).not.toBeInTheDocument();
  },
  render: () => <ArticleFeed articles={[]} emptyState="saved" feedType="bookmarks" isLoading />,
};

export const Error: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "保存した記事を読み込めませんでした" }),
    ).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "再試行" }));
    await readyFeed(canvasElement);
    await expect(canvas.getByRole("heading", { name: articles[0]!.title })).toBeVisible();
    await expect(
      canvas.queryByRole("heading", { name: "保存した記事を読み込めませんでした" }),
    ).not.toBeInTheDocument();
  },
  render: () => <BookmarksErrorPreview />,
};
