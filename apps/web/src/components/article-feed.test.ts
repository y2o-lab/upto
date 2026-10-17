// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { FeedArticle } from "../lib/articles";
import type { UserArticleStateSnapshot } from "../lib/use-user-article-state";

import { markArticleRead } from "../lib/user-state-db";
import { ArticleFeed } from "./article-feed";

const state = vi.hoisted(() => ({ snapshot: null as UserArticleStateSnapshot | null }));
vi.mock("../lib/use-user-article-state", () => ({
  useUserArticleState: () => state.snapshot,
}));
vi.mock("../lib/user-state-db", () => ({
  markArticleRead: vi.fn().mockResolvedValue(undefined),
  markArticleSaved: vi.fn().mockResolvedValue(undefined),
  saveReadingProgress: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("./theme-toggle", () => ({ ThemeToggle: () => null }));

const articles: FeedArticle[] = ["first", "second"].map((id) => ({
  id,
  title: id,
  summary: "要約",
  summaryBullets: ["要点"],
  sourceId: "source",
  sourceName: "出典",
  sourceSiteUrl: "https://example.com",
  originalUrl: `https://example.com/${id}`,
  normalizedUrl: `https://example.com/${id}`,
  publishedAt: "2026-10-17T00:00:00.000Z",
  score: 1,
  bookmarks: 0,
  views: 0,
  difficulty: "beginner",
  modelId: "test",
  oneLineSummary: null,
  whyItMatters: null,
  tags: [],
}));

let root: Root;
let container: HTMLDivElement;

async function renderFeed() {
  await act(async () => root.render(createElement(ArticleFeed, { articles })));
}

async function advance(ms: number) {
  await act(async () => vi.advanceTimersByTimeAsync(ms));
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  state.snapshot = {
    isLoaded: true,
    readArticleIds: new Set(),
    savedArticleIds: new Set(),
    readingProgressArticleId: null,
  };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await renderFeed();
  container.querySelector<HTMLElement>('[data-testid="article-feed"]')!.scrollTo = vi.fn();
  await advance(20);
  expect(container.querySelector('[data-testid="article-feed"]')?.getAttribute("data-ready")).toBe(
    "true",
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

it("marks the active article read after one second, never earlier", async () => {
  await advance(999);
  expect(markArticleRead).not.toHaveBeenCalled();
  await advance(1);
  expect(markArticleRead).toHaveBeenCalledExactlyOnceWith("first");
});

it("preserves elapsed dwell time when progress, saved state, or other read IDs update", async () => {
  await advance(500);
  state.snapshot = {
    ...state.snapshot!,
    readingProgressArticleId: "first",
    savedArticleIds: new Set(["first"]),
    readArticleIds: new Set(["other"]),
  };
  await renderFeed();
  await advance(499);
  expect(markArticleRead).not.toHaveBeenCalled();
  await advance(1);
  expect(markArticleRead).toHaveBeenCalledExactlyOnceWith("first");
});

it("cancels the old timer on navigation and gives the next article a full second", async () => {
  await advance(600);
  await act(async () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
  });
  await advance(999);
  expect(markArticleRead).not.toHaveBeenCalled();
  await advance(1);
  expect(markArticleRead).toHaveBeenCalledExactlyOnceWith("second");
});

it("cancels a pending write when the active article becomes read elsewhere", async () => {
  await advance(500);
  state.snapshot = { ...state.snapshot!, readArticleIds: new Set(["first"]) };
  await renderFeed();
  await advance(1_000);
  expect(markArticleRead).not.toHaveBeenCalled();
});

it("cancels the timer on unmount", async () => {
  await advance(500);
  await act(async () => root.render(null));
  await advance(1_000);
  expect(markArticleRead).not.toHaveBeenCalled();
});
