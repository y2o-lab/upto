"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { FeedArticle } from "../lib/articles";

import { useSavedArticleIds } from "../lib/use-user-article-state";
import { ArticleFeed } from "./article-feed";

export function SavedArticlesFeed() {
  const { isLoaded, savedArticleIds } = useSavedArticleIds();
  const savedArticleIdsKey = useMemo(() => savedArticleIds.join(","), [savedArticleIds]);
  const [articles, setArticles] = useState<FeedArticle[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  const retry = useCallback(() => setRetryCount((count) => count + 1), []);

  useEffect(() => {
    if (!isLoaded) {
      return;
    }

    if (!savedArticleIdsKey) {
      setArticles([]);
      setError(null);
      setIsLoading(false);
      return;
    }

    const controller = new AbortController();
    setIsLoading(true);
    setError(null);

    void fetch(`/api/articles?${new URLSearchParams({ ids: savedArticleIdsKey })}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error("Failed to load saved articles");
        }

        return (await response.json()) as { articles: FeedArticle[] };
      })
      .then((response) => setArticles(response.articles))
      .catch((requestError: unknown) => {
        if (requestError instanceof DOMException && requestError.name === "AbortError") {
          return;
        }

        setError("保存した記事の取得に失敗しました");
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setIsLoading(false);
        }
      });

    return () => controller.abort();
  }, [isLoaded, retryCount, savedArticleIdsKey]);

  return (
    <div
      data-testid={
        articles.length === 0 && isLoaded && !isLoading && !error ? "bookmarks-empty" : undefined
      }
    >
      <ArticleFeed
        articles={articles}
        emptyState="saved"
        feedType="bookmarks"
        isLoading={!isLoaded || (isLoading && articles.length === 0)}
        loadError={error}
        onRetry={retry}
      />
    </div>
  );
}
