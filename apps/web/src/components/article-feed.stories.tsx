import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { expect, fn, userEvent, waitFor, within } from "storybook/test";

import type { FeedArticle } from "../lib/articles";

import { getUserStateDb, markArticleRead, markArticleSaved } from "../lib/user-state-db";
import { expectActiveCard, expectInsideCard, readyFeed } from "../test/storybook";
import { ArticleFeed } from "./article-feed";

const articles = [
  {
    bookmarks: 42,
    difficulty: "intermediate",
    id: "00000000-0000-4000-8000-000000000001",
    modelId: "storybook",
    normalizedUrl: "https://zenn.dev/example/articles/next-news",
    oneLineSummary: "Next.js App Router と Server Components を活用した記事配信の実装例です。",
    originalUrl: "https://zenn.dev/example/articles/next-news",
    publishedAt: new Date("2026-06-13T00:00:00.000Z").toISOString(),
    score: 83,
    sourceId: "00000000-0000-4000-8000-100000000001",
    sourceName: "Zenn",
    sourceSiteUrl: "https://zenn.dev",
    summary:
      "Next.js App Router と Server Components を土台に、初期表示を軽く保ちながら縦スワイプ型ニュースフィードを構成する実装例です。",
    summaryBullets: [
      "初期表示は Server Component で取得する",
      "カード遷移は Client Component に閉じ込める",
      "追加取得は cursor pagination で拡張する",
    ],
    tags: ["Next.js", "React", "UI"],
    title: "Next.js で縦スワイプ型ニュース UI を作る",
    views: 820,
    whyItMatters:
      "サーバー取得とクライアント操作の責務を分けることで、MVPでも拡張しやすいUIを作れます。",
  },
  {
    bookmarks: 31,
    difficulty: "beginner",
    id: "00000000-0000-4000-8000-000000000002",
    modelId: "storybook",
    normalizedUrl: "https://qiita.com/example/items/collector",
    oneLineSummary: "RSS 取得、本文抽出、LLM 要約を安全に進めるためのバッチ設計です。",
    originalUrl: "https://qiita.com/example/items/collector",
    publishedAt: new Date("2026-06-13T01:00:00.000Z").toISOString(),
    score: 61,
    sourceId: "00000000-0000-4000-8000-100000000002",
    sourceName: "Qiita",
    sourceSiteUrl: "https://qiita.com",
    summary:
      "ニュース収集バッチをidempotentに動かすため、crawl_jobs と記事単位のステータスで実行結果を記録します。",
    summaryBullets: [
      "crawl_jobs に実行状態を保存する",
      "記事単位の失敗を retry_count で管理する",
      "Gemini の rate limit を concurrency で制御する",
    ],
    tags: ["Batch", "PostgreSQL", "Gemini"],
    title: "ニュース収集バッチを安全に設計する",
    views: 510,
    whyItMatters:
      "外部APIとLLMを扱うバッチでは、部分失敗を前提にした永続化が運用安定性に直結します。",
  },
] satisfies [FeedArticle, ...FeedArticle[]];

const meta = {
  title: "Components/ArticleFeed",
  component: ArticleFeed,
  parameters: {
    layout: "fullscreen",
  },
  args: {
    articles,
  },
} satisfies Meta<typeof ArticleFeed>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await readyFeed(canvasElement);
    await expectActiveCard(canvasElement, 0);
    await userEvent.click(canvas.getByRole("button", { name: "次の記事へ" }));
    await expectActiveCard(canvasElement, 1);
    await expect(canvas.getByText("2 / 2")).toBeVisible();
    const card = within(canvas.getByTestId("article-card-1"));
    await userEvent.click(card.getByRole("button", { name: "記事を保存する" }));
    await waitFor(() =>
      expect(card.getByRole("button", { name: "保存を解除する" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    await waitFor(async () =>
      expect(await getUserStateDb()?.savedArticles.get(articles[1].id)).toBeDefined(),
    );
  },
};

export const LoadingMore: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = await readyFeed(canvasElement);
    await expect(
      await canvas.findByRole("heading", { name: "追加記事を読み込んでいます" }),
    ).toBeVisible();
    await expect(canvas.getByTestId("article-card-0")).toBeInTheDocument();
    await expect(args.loadMoreArticles).toHaveBeenCalledTimes(1);
    await expect(canvas.queryByRole("button", { name: "再試行" })).not.toBeInTheDocument();
  },
  args: {
    articles: articles.slice(0, 1),
    initialActiveIndex: 1,
    initialCursor: "storybook-cursor",
    initialHasMore: true,
    loadMoreArticles: fn(() => new Promise<never>(() => {})),
  },
};

export const LoadMoreError: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = await readyFeed(canvasElement);
    await expect(
      await canvas.findByRole("heading", { name: "追加読み込みに失敗しました" }),
    ).toBeVisible();
    await expect(canvas.getByTestId("article-card-0")).toBeInTheDocument();
    await userEvent.click(canvas.getByRole("button", { name: "再試行" }));
    await waitFor(() => expect(args.loadMoreArticles).toHaveBeenCalledTimes(2));
    await expect(await canvas.findByRole("heading", { name: articles[1].title })).toBeVisible();
    await expectActiveCard(canvasElement, 1);
    await expect(canvas.queryByTestId("feed-load-more")).not.toBeInTheDocument();
  },
  beforeEach: ({ args }) => {
    const loadMore = args.loadMoreArticles as ReturnType<typeof fn>;
    loadMore.mockReset();
    loadMore.mockRejectedValueOnce(new Error("storybook error")).mockResolvedValue({
      articles: [articles[1]],
      hasMore: false,
      nextCursor: null,
      snapshotAt: "2026-06-13T03:00:00.000Z",
    });
  },
  args: {
    articles: articles.slice(0, 1),
    initialActiveIndex: 1,
    initialCursor: "storybook-cursor",
    initialHasMore: true,
    loadMoreArticles: fn(),
  },
};

export const Complete: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await readyFeed(canvasElement);
    await expect(canvas.getByRole("heading", { name: "今日の新着は以上です" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "先頭へ戻る" }));
    await expectActiveCard(canvasElement, 0);
    await expect(canvas.getByText("1 / 1")).toBeVisible();
  },
  args: {
    articles: articles.slice(0, 1),
    initialActiveIndex: 1,
    initialHasMore: false,
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
    await expect(canvas.queryByText("未読の記事を準備しています")).not.toBeInTheDocument();
  },
  args: {
    articles: [],
  },
};

export const LongContent: Story = {
  play: async ({ canvasElement, args, globals }) => {
    const viewport = globals.viewport?.value;
    if (viewport === "mobile" || viewport === "desktop") {
      await expect(window.innerWidth).toBe(viewport === "mobile" ? 393 : 1280);
      await expect(window.innerHeight).toBe(viewport === "mobile" ? 851 : 800);
    }
    const canvas = await readyFeed(canvasElement);
    const card = canvas.getByTestId("article-card-0");
    const content = within(card);
    await expectInsideCard(card, [
      content.getByRole("heading", { name: args.articles[0]!.title }),
      ...content.getAllByRole("listitem"),
      content.getByText(args.articles[0]!.whyItMatters!),
      content.getByRole("link", { name: "元記事を読む" }),
      content.getByRole("button", { name: "記事を保存する" }),
    ]);
  },
  args: {
    articles: [
      {
        ...articles[0],
        title:
          "日本語の長い記事タイトルでも読みやすさを保つためのニュースフィード設計と実装のポイントを詳しく解説する",
        oneLineSummary:
          "タイトルや要約が長い場合にも、要点・重要性・元記事への導線が読み取れる構成を確認します。",
        summary:
          "大量のニュースを短時間で読むためには、長い文章を含む記事でも情報の優先順位が崩れず、狭い画面に要点と操作が収まる必要があります。".repeat(
            3,
          ),
        summaryBullets: [
          "長い日本語タイトルは折り返しを制御し、記事の要点を読むための領域を確保する。",
          "モバイルとデスクトップの双方で、要点と重要性を確認してから元記事を開ける。",
          "タグが長くても保存ボタンや元記事リンクに重ならないことを確認する。",
        ],
        whyItMatters:
          "情報量の多い記事でも要点と操作を見失わず、移動中の短い時間でニュースを読めます。",
        tags: ["日本語ニュースフィードの設計", "レスポンシブデザイン", "アクセシビリティ"],
      },
    ],
  },
};

export const Saved: Story = {
  play: async ({ canvasElement }) => {
    const canvas = await readyFeed(canvasElement);
    const card = within(canvas.getByTestId("article-card-0"));
    const button = await card.findByRole("button", { name: "保存を解除する" });
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect(card.getByTitle("保存済み")).toBeVisible();
    await userEvent.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "false"));
    await waitFor(async () =>
      expect(await getUserStateDb()?.savedArticles.get(articles[0].id)).toBeUndefined(),
    );
    await expect(card.queryByTitle("保存済み")).not.toBeInTheDocument();
  },
  beforeEach: async () => {
    await markArticleSaved(articles[0].id, true);
  },
};

export const Read: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await waitFor(() =>
      expect(canvas.getByTestId("article-feed")).toHaveAttribute("data-ready", "true"),
    );
    // Mark after the home feed freezes its initial exclusion set, as in a browsing session.
    await markArticleRead(articles[0].id);
    await waitFor(() => expect(canvas.getAllByTitle("既読").length).toBeGreaterThan(0));
  },
};
