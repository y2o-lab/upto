"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ArticlePage, FeedArticle } from "../lib/articles";

import { logWarning } from "../lib/logging";
import { useUserArticleState } from "../lib/use-user-article-state";
import { markArticleRead, markArticleSaved, saveReadingProgress } from "../lib/user-state-db";
import { ThemeToggle } from "./theme-toggle";

type ArticleFeedProps = {
  articles: FeedArticle[];
  emptyState?: "default" | "saved";
  feedType?: string;
  initialActiveIndex?: number;
  initialCursor?: string | null;
  initialHasMore?: boolean;
  initialSnapshotAt?: string;
  isLoading?: boolean;
  loadError?: string | null;
  loadMoreArticles?: (cursor: string, limit: number, snapshotAt: string) => Promise<ArticlePage>;
  onRetry?: () => void;
};

const wheelThreshold = 70;
const wheelCooldownMs = 520;
const loadMorePageSize = 10;
const maxProgressDots = 12;

export function ArticleFeed({
  articles,
  emptyState = "default",
  feedType = "home",
  initialActiveIndex = 0,
  initialCursor = null,
  initialHasMore = false,
  initialSnapshotAt,
  isLoading = false,
  loadError = null,
  loadMoreArticles = fetchArticlePage,
  onRetry,
}: ArticleFeedProps) {
  const generatedSnapshotAtRef = useRef(initialSnapshotAt ?? new Date().toISOString());
  const effectiveInitialSnapshotAt = initialSnapshotAt ?? generatedSnapshotAtRef.current;
  const [feedArticles, setFeedArticles] = useState(() => articles);
  const [activeIndex, setActiveIndex] = useState(initialActiveIndex);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [hasRestoredProgress, setHasRestoredProgress] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(initialCursor);
  const [snapshotAt, setSnapshotAt] = useState(effectiveInitialSnapshotAt);
  const containerRef = useRef<HTMLDivElement>(null);
  const isLoadingMoreRef = useRef(false);
  const wheelRef = useRef({
    accumulatedDelta: 0,
    lastDirection: 0,
    lastMoveAt: 0,
  });
  const activeIndexRef = useRef(activeIndex);
  const initialArticleIdsKey = useMemo(
    () => articles.map((article) => article.id).join("\u001f"),
    [articles],
  );
  const articleIds = useMemo(() => feedArticles.map((article) => article.id), [feedArticles]);
  const userState = useUserArticleState(articleIds, feedType);
  const activeArticle = activeIndex < feedArticles.length ? feedArticles[activeIndex] : null;
  const hasTerminalCard = !hasMore;

  useEffect(() => {
    setIsReady(true);
  }, []);

  useEffect(() => {
    setFeedArticles(articles);
    setNextCursor(initialCursor);
    setSnapshotAt(effectiveInitialSnapshotAt);
    setHasMore(initialHasMore);
    setIsLoadingMore(false);
    setLoadMoreError(null);
    setActiveIndex(initialActiveIndex);
    setHasRestoredProgress(false);
  }, [
    articles,
    initialActiveIndex,
    initialArticleIdsKey,
    initialCursor,
    initialHasMore,
    effectiveInitialSnapshotAt,
    feedType,
  ]);

  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  const scrollToIndex = useCallback(
    (nextIndex: number, behavior: ScrollBehavior = "smooth") => {
      if (feedArticles.length === 0) {
        return;
      }

      const maxIndex = hasMore || hasTerminalCard ? feedArticles.length : feedArticles.length - 1;
      const boundedIndex = Math.max(0, Math.min(nextIndex, maxIndex));
      const container = containerRef.current;
      const target = container?.children.item(boundedIndex);
      activeIndexRef.current = boundedIndex;
      setActiveIndex(boundedIndex);
      if (!(container && target instanceof HTMLElement)) {
        return;
      }

      container.scrollTo({
        behavior,
        top: target.offsetTop - container.offsetTop,
      });
    },
    [feedArticles.length, hasMore, hasTerminalCard],
  );

  useEffect(() => {
    if (isReady && initialActiveIndex > 0) {
      window.requestAnimationFrame(() => scrollToIndex(initialActiveIndex, "auto"));
    }
  }, [initialActiveIndex, isReady, scrollToIndex]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || feedArticles.length === 0) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const visibleEntry = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];

        if (!visibleEntry) {
          return;
        }

        const nextIndex = Number((visibleEntry.target as HTMLElement).dataset.index);
        if (Number.isFinite(nextIndex)) {
          setActiveIndex(nextIndex);
        }
      },
      {
        root: container,
        threshold: [0.55, 0.75],
      },
    );

    for (const child of Array.from(container.children)) {
      observer.observe(child);
    }

    return () => observer.disconnect();
  }, [feedArticles.length, hasMore, isLoadingMore, loadMoreError]);

  useEffect(() => {
    if (!userState.isLoaded || hasRestoredProgress || feedArticles.length === 0) {
      return;
    }

    const restoredIndex = feedArticles.findIndex(
      (article) => article.id === userState.readingProgressArticleId,
    );
    setHasRestoredProgress(true);
    if (restoredIndex > 0) {
      window.requestAnimationFrame(() => scrollToIndex(restoredIndex, "auto"));
    }
  }, [
    feedArticles,
    hasRestoredProgress,
    scrollToIndex,
    userState.isLoaded,
    userState.readingProgressArticleId,
  ]);

  useEffect(() => {
    if (!(hasRestoredProgress && userState.isLoaded && activeArticle)) {
      return;
    }

    void saveReadingProgress(feedType, activeArticle.id).catch((error: unknown) =>
      logWarning("Failed to save reading progress", error),
    );
  }, [activeArticle, feedType, hasRestoredProgress, userState.isLoaded]);

  useEffect(() => {
    if (!(hasRestoredProgress && activeArticle)) {
      return;
    }

    if (userState.readArticleIds.has(activeArticle.id)) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void markArticleRead(activeArticle.id).catch((error: unknown) =>
        logWarning("Failed to mark article read", error),
      );
    }, 3_000);

    return () => window.clearTimeout(timeoutId);
  }, [activeArticle, hasRestoredProgress, userState.readArticleIds]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "ArrowDown" || (event.key === " " && !event.shiftKey)) {
        event.preventDefault();
        scrollToIndex(activeIndexRef.current + 1);
      }

      if (event.key === "ArrowUp" || (event.key === " " && event.shiftKey)) {
        event.preventDefault();
        scrollToIndex(activeIndexRef.current - 1);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [scrollToIndex]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) {
      return;
    }

    function onWheel(event: WheelEvent) {
      if (feedArticles.length === 0 || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) {
        return;
      }

      const now = Date.now();
      const wheelState = wheelRef.current;

      if (now - wheelState.lastMoveAt < wheelCooldownMs) {
        event.preventDefault();
        return;
      }

      const direction = Math.sign(event.deltaY);
      if (direction !== wheelState.lastDirection) {
        wheelState.accumulatedDelta = 0;
        wheelState.lastDirection = direction;
      }

      wheelState.accumulatedDelta += event.deltaY;
      event.preventDefault();
      if (Math.abs(wheelState.accumulatedDelta) < wheelThreshold) {
        return;
      }

      scrollToIndex(activeIndexRef.current + (wheelState.accumulatedDelta > 0 ? 1 : -1));
      wheelState.accumulatedDelta = 0;
      wheelState.lastMoveAt = now;
    }

    container.addEventListener("wheel", onWheel, { passive: false });
    return () => container.removeEventListener("wheel", onWheel);
  }, [feedArticles.length, scrollToIndex]);

  const loadMore = useCallback(async () => {
    if (!hasMore || !nextCursor || isLoadingMoreRef.current) {
      return false;
    }

    isLoadingMoreRef.current = true;
    setIsLoadingMore(true);
    setLoadMoreError(null);

    try {
      const page = await loadMoreArticles(nextCursor, loadMorePageSize, snapshotAt);
      setFeedArticles((currentArticles) => {
        const existingIds = new Set(currentArticles.map((article) => article.id));
        const newArticles = page.articles.filter((article) => !existingIds.has(article.id));
        return [...currentArticles, ...newArticles];
      });
      setNextCursor(page.nextCursor);
      setSnapshotAt(page.snapshotAt);
      setHasMore(page.hasMore);
      return true;
    } catch (error) {
      logWarning("Failed to load more articles", error);
      setLoadMoreError("追加読み込みに失敗しました");
      return false;
    } finally {
      isLoadingMoreRef.current = false;
      setIsLoadingMore(false);
    }
  }, [hasMore, loadMoreArticles, nextCursor, snapshotAt]);

  useEffect(() => {
    if (activeIndex >= feedArticles.length - 2 && !loadMoreError) {
      void loadMore();
    }
  }, [activeIndex, feedArticles.length, loadMore, loadMoreError]);

  async function moveForwardFromArticle(index: number) {
    if (index === feedArticles.length - 1 && hasMore) {
      const loaded = await loadMore();
      scrollToIndex(loaded ? index + 1 : feedArticles.length);
      return;
    }

    scrollToIndex(index + 1);
  }

  function toggleSaved(article: FeedArticle, isSaved: boolean) {
    void markArticleSaved(article.id, !isSaved).catch((error: unknown) =>
      logWarning("Failed to update saved article", error),
    );
  }

  if (feedArticles.length === 0) {
    const isSavedFeed = emptyState === "saved";
    return (
      <section className="flex h-dvh flex-col overflow-hidden">
        <AppHeader activeIndex={0} articleCount={0} feedType={feedType} hasMore={false} />
        <div className="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col justify-center px-4">
          <p className="text-sm font-medium text-[var(--accent)]">Upto</p>
          <h2 className="mt-3 text-3xl leading-tight font-semibold text-balance">
            {isLoading
              ? "保存した記事を読み込んでいます"
              : loadError
                ? "保存した記事を読み込めませんでした"
                : isSavedFeed
                  ? "保存した記事はありません"
                  : "まだ表示できる記事がありません"}
          </h2>
          <p className="mt-5 max-w-xl leading-7 text-[var(--muted)]">
            {isSavedFeed
              ? "記事の☆を選択すると、あとでここからまとめて読めます。"
              : "collector batch を実行して、要約済みの記事がDBへ保存されるとここに表示されます。本番環境ではデータベース接続設定を確認し、定期バッチを起動してください。"}
          </p>
          {loadError && onRetry ? (
            <button
              className="mt-5 w-fit rounded-md bg-[var(--foreground)] px-4 py-2 text-sm font-medium text-[var(--background)] transition hover:bg-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
              onClick={onRetry}
              type="button"
            >
              再試行
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  return (
    <section className="flex h-dvh flex-col overflow-hidden">
      <AppHeader
        activeIndex={activeIndex}
        articleCount={feedArticles.length}
        feedType={feedType}
        hasMore={hasMore}
      />

      <div
        ref={containerRef}
        className="min-h-0 flex-1 snap-y snap-mandatory overflow-y-auto overscroll-y-contain scroll-smooth"
        data-ready={isReady ? "true" : "false"}
        data-snapshot-at={snapshotAt}
        data-testid="article-feed"
      >
        {feedArticles.map((article, index) => {
          const isRead = userState.readArticleIds.has(article.id);
          const isSaved = userState.savedArticleIds.has(article.id);

          return (
            <article
              data-index={index}
              data-testid={`article-card-${index}`}
              key={article.id}
              className="mx-auto flex h-full max-w-3xl snap-start items-center px-4 py-3"
            >
              <div className="flex h-full w-full flex-col overflow-hidden">
                <div className="mb-2 flex shrink-0 flex-wrap items-center gap-2 text-xs font-medium">
                  <span
                    aria-label={isRead ? "既読" : "未読"}
                    className={
                      isRead
                        ? "size-2 rounded-full bg-[var(--border-strong)]"
                        : "size-2 rounded-full bg-blue-500"
                    }
                    title={isRead ? "既読" : "未読"}
                  />
                  <span className="rounded-full bg-[var(--accent-soft)] px-3 py-1 text-[var(--accent)]">
                    {article.sourceName}
                  </span>
                  <span className="rounded-full bg-[var(--surface)] px-3 py-1 text-[var(--muted)] shadow-sm">
                    {difficultyLabel(article.difficulty)}
                  </span>
                  {article.publishedAt ? (
                    <time
                      className="text-[var(--muted)]"
                      dateTime={article.publishedAt}
                      title={formatAbsoluteDate(article.publishedAt)}
                    >
                      {formatRelativeDate(article.publishedAt)}
                    </time>
                  ) : null}
                </div>

                <div className="flex shrink-0 items-start gap-2">
                  {isSaved ? (
                    <span
                      aria-label="保存済み"
                      className="mt-1 text-lg leading-none text-[var(--accent)]"
                      title="保存済み"
                    >
                      ★
                    </span>
                  ) : null}
                  <h2
                    className={`line-clamp-2 text-xl leading-snug text-balance sm:text-2xl ${
                      isRead
                        ? "font-normal text-[var(--muted)]"
                        : "font-semibold text-[var(--foreground)]"
                    }`}
                  >
                    {article.title}
                  </h2>
                </div>
                {article.oneLineSummary ? (
                  <p
                    className={`mt-2 line-clamp-1 shrink-0 text-sm leading-6 font-medium sm:text-base ${
                      isRead ? "text-[var(--muted)]" : "text-[var(--foreground)]"
                    }`}
                  >
                    {article.oneLineSummary}
                  </p>
                ) : null}
                <p className="mt-2 hidden shrink-0 text-sm leading-6 text-[var(--muted)] sm:line-clamp-1 sm:block">
                  {article.summary}
                </p>

                <ul className="mt-3 shrink-0 space-y-1.5" data-summary-bullets="true">
                  {article.summaryBullets.slice(0, 3).map((bullet) => (
                    <li
                      key={bullet}
                      className="rounded-lg bg-[var(--surface)] px-3 py-1.5 text-sm leading-5 shadow-sm"
                    >
                      {bullet}
                    </li>
                  ))}
                </ul>

                {article.whyItMatters ? (
                  <p
                    className="mt-3 shrink-0 rounded-lg border border-[var(--border)] bg-[var(--surface-muted)] px-3 py-1.5 text-xs leading-5 text-[var(--muted)]"
                    data-why-it-matters="true"
                  >
                    {article.whyItMatters}
                  </p>
                ) : null}

                <div className="mt-3 flex h-6 shrink-0 flex-nowrap gap-2 overflow-hidden">
                  {article.tags.slice(0, 3).map((tag) => (
                    <span
                      className="shrink-0 rounded-full border border-[var(--border)] px-3 py-1 text-xs text-[var(--muted)]"
                      key={tag}
                    >
                      #{tag}
                    </span>
                  ))}
                </div>

                <div className="mt-auto flex shrink-0 flex-wrap items-center justify-between gap-3 pt-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <a
                      className="rounded-md bg-[var(--foreground)] px-4 py-2 text-sm font-medium text-[var(--background)] transition hover:bg-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                      href={article.originalUrl}
                      onClick={() => {
                        void markArticleRead(article.id).catch((error: unknown) =>
                          logWarning("Failed to mark article read", error),
                        );
                      }}
                      rel="noreferrer"
                      target="_blank"
                    >
                      元記事を読む
                    </a>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-xs whitespace-nowrap text-[var(--muted)]">
                      score {Math.round(article.score)} / {article.bookmarks} bookmarks
                    </span>
                    <button
                      aria-label={isSaved ? "保存を解除する" : "記事を保存する"}
                      aria-pressed={isSaved}
                      className="inline-flex size-9 items-center justify-center rounded-md border border-[var(--border)] bg-[var(--surface)] text-lg leading-none transition hover:border-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                      data-saved={isSaved ? "true" : "false"}
                      data-testid={`save-article-${index}`}
                      onClick={() => toggleSaved(article, isSaved)}
                      title={isSaved ? "保存を解除" : "保存"}
                      type="button"
                    >
                      {isSaved ? "★" : "☆"}
                    </button>
                    <button
                      className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-4 py-2 text-sm transition hover:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-45"
                      onClick={() => {
                        void moveForwardFromArticle(index);
                      }}
                      type="button"
                    >
                      {index === feedArticles.length - 1
                        ? hasMore
                          ? "追加記事を読む"
                          : "読み終える"
                        : "次の記事へ"}
                    </button>
                  </div>
                </div>

                <div
                  className="mt-2 flex shrink-0 gap-1.5"
                  aria-hidden="true"
                  data-progress-dots="true"
                >
                  {getProgressDotIndexes(feedArticles.length, index).map((dotIndex) => (
                    <span
                      className={
                        dotIndex === index
                          ? "h-1.5 w-5 rounded-full bg-[var(--accent)]"
                          : "h-1.5 w-1.5 rounded-full bg-[var(--border-strong)]"
                      }
                      key={dotIndex}
                    />
                  ))}
                </div>
              </div>
            </article>
          );
        })}
        {hasMore ? (
          <LoadMoreStatusCard
            index={feedArticles.length}
            isLoading={isLoadingMore}
            message={loadMoreError}
            onRetry={() => {
              void loadMore();
            }}
          />
        ) : (
          <FeedCompleteCard index={feedArticles.length} onBackToTop={() => scrollToIndex(0)} />
        )}
      </div>
    </section>
  );
}

function AppHeader({
  activeIndex,
  articleCount,
  feedType,
  hasMore,
}: {
  activeIndex: number;
  articleCount: number;
  feedType: string;
  hasMore: boolean;
}) {
  const isSavedFeed = feedType === "bookmarks";
  return (
    <header className="shrink-0 border-b border-[var(--border)] bg-[var(--background)]/92 px-4 py-3 backdrop-blur">
      <div className="mx-auto flex max-w-3xl items-center justify-between gap-4">
        <div>
          <h1 className="text-lg leading-none font-semibold tracking-normal">Upto</h1>
          <p className="mt-1 text-xs text-[var(--muted)]">日本語ITニュース要約</p>
        </div>
        <div className="flex items-center gap-2">
          <Link
            className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 py-1 text-sm text-[var(--muted)] transition hover:border-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
            href={isSavedFeed ? "/" : "/bookmarks"}
          >
            {isSavedFeed ? "新着記事" : "保存記事"}
          </Link>
          <ThemeToggle />
          <span className="rounded-full bg-[var(--surface)] px-3 py-1 text-sm text-[var(--muted)] shadow-sm">
            {articleCount === 0
              ? "0 / 0"
              : activeIndex >= articleCount
                ? hasMore
                  ? `${articleCount} / ${articleCount}`
                  : "完了"
                : `${activeIndex + 1} / ${articleCount}`}
          </span>
        </div>
      </div>
    </header>
  );
}

function LoadMoreStatusCard({
  index,
  isLoading,
  message,
  onRetry,
}: {
  index: number;
  isLoading: boolean;
  message: string | null;
  onRetry: () => void;
}) {
  return (
    <article
      className="mx-auto flex h-full max-w-3xl snap-start items-center px-4 py-3"
      data-index={index}
      data-testid="feed-load-more"
    >
      <div className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 shadow-sm">
        <p className="text-sm font-medium text-[var(--accent)]">Upto</p>
        <h2 className="mt-3 text-2xl leading-tight font-semibold text-balance">
          {message ? "追加読み込みに失敗しました" : "追加記事を読み込んでいます"}
        </h2>
        <p className="mt-3 text-sm leading-6 text-[var(--muted)]">
          {message ? "通信状態を確認してから再試行してください。" : "次の記事を準備しています。"}
        </p>
        {message ? (
          <button
            className="mt-5 rounded-md bg-[var(--foreground)] px-4 py-2 text-sm font-medium text-[var(--background)] transition hover:bg-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-45"
            disabled={isLoading}
            onClick={onRetry}
            type="button"
          >
            {isLoading ? "再試行中" : "再試行"}
          </button>
        ) : null}
      </div>
    </article>
  );
}

function FeedCompleteCard({ index, onBackToTop }: { index: number; onBackToTop: () => void }) {
  return (
    <article
      className="mx-auto flex h-full max-w-3xl snap-start items-center px-4 py-3"
      data-index={index}
      data-testid="feed-complete"
    >
      <div className="w-full">
        <p className="text-sm font-medium text-[var(--accent)]">Upto</p>
        <h2 className="mt-3 text-3xl leading-tight font-semibold text-balance">
          今日の新着は以上です
        </h2>
        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          {["今週の人気記事", "AIまとめ", "おすすめ記事"].map((label) => (
            <div
              className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 shadow-sm"
              key={label}
            >
              <p className="text-sm font-semibold">{label}</p>
              <p className="mt-2 text-xs leading-5 text-[var(--muted)]">
                追加フィードの候補として準備中です。
              </p>
            </div>
          ))}
        </div>
        <button
          className="mt-6 rounded-md bg-[var(--foreground)] px-4 py-2 text-sm font-medium text-[var(--background)] transition hover:bg-[var(--accent)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          onClick={onBackToTop}
          type="button"
        >
          先頭へ戻る
        </button>
      </div>
    </article>
  );
}

function difficultyLabel(difficulty: FeedArticle["difficulty"]): string {
  if (difficulty === "beginner") {
    return "入門";
  }

  if (difficulty === "advanced") {
    return "深掘り";
  }

  return "実務";
}

function getProgressDotIndexes(articleCount: number, currentIndex: number): number[] {
  if (articleCount <= maxProgressDots) {
    return Array.from({ length: articleCount }, (_, index) => index);
  }

  const halfWindow = Math.floor(maxProgressDots / 2);
  const start = Math.min(
    Math.max(currentIndex - halfWindow + 1, 0),
    articleCount - maxProgressDots,
  );

  return Array.from({ length: maxProgressDots }, (_, index) => start + index);
}

function formatAbsoluteDate(value: string): string {
  return new Intl.DateTimeFormat("ja-JP", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Tokyo",
  }).format(new Date(value));
}

function formatRelativeDate(value: string): string {
  const publishedAt = new Date(value).getTime();
  const diffMinutes = Math.max(0, Math.floor((Date.now() - publishedAt) / 60_000));

  if (diffMinutes < 60) {
    return `${diffMinutes || 1}分前`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) {
    return `${diffHours}時間前`;
  }

  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) {
    return `${diffDays}日前`;
  }

  return new Intl.DateTimeFormat("ja-JP", {
    month: "numeric",
    timeZone: "Asia/Tokyo",
    day: "numeric",
  }).format(new Date(value));
}

async function fetchArticlePage(
  cursor: string,
  limit: number,
  snapshotAt: string,
): Promise<ArticlePage> {
  const params = new URLSearchParams({
    cursor,
    limit: String(limit),
    snapshotAt,
  });
  const response = await fetch(`/api/articles?${params.toString()}`, {
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error("Failed to load more articles");
  }

  return (await response.json()) as ArticlePage;
}
