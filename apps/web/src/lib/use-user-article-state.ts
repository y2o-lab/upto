"use client";

import { liveQuery } from "dexie";
import { useEffect, useMemo, useState } from "react";

import { getUserStateDb } from "./user-state-db";

export type UserArticleStateSnapshot = {
  isLoaded: boolean;
  readArticleIds: Set<string>;
  readingProgressArticleId: string | null;
  savedArticleIds: Set<string>;
};

export type SavedArticleIdsSnapshot = {
  isLoaded: boolean;
  savedArticleIds: string[];
};

const emptySnapshot: UserArticleStateSnapshot = {
  isLoaded: false,
  readArticleIds: new Set(),
  readingProgressArticleId: null,
  savedArticleIds: new Set(),
};

const emptySavedArticleIdsSnapshot: SavedArticleIdsSnapshot = {
  isLoaded: false,
  savedArticleIds: [],
};

export function useSavedArticleIds(): SavedArticleIdsSnapshot {
  const [snapshot, setSnapshot] = useState<SavedArticleIdsSnapshot>(emptySavedArticleIdsSnapshot);

  useEffect(() => {
    const db = getUserStateDb();
    if (!db) {
      setSnapshot({ isLoaded: true, savedArticleIds: [] });
      return;
    }

    const subscription = liveQuery(() =>
      db.savedArticles.orderBy("savedAt").reverse().toArray(),
    ).subscribe({
      error: () => setSnapshot({ isLoaded: true, savedArticleIds: [] }),
      next: (savedArticles) =>
        setSnapshot({
          isLoaded: true,
          savedArticleIds: savedArticles.map((article) => article.articleId),
        }),
    });

    return () => subscription.unsubscribe();
  }, []);

  return snapshot;
}

export function useUserArticleState(
  articleIds: string[],
  feedType: string,
): UserArticleStateSnapshot {
  const articleIdsKey = useMemo(() => articleIds.join("\u001f"), [articleIds]);
  const [snapshot, setSnapshot] = useState<UserArticleStateSnapshot>(emptySnapshot);

  useEffect(() => {
    const db = getUserStateDb();
    if (!db) {
      setSnapshot({ ...emptySnapshot, isLoaded: true });
      return;
    }

    const ids = articleIdsKey ? articleIdsKey.split("\u001f") : [];
    const subscription = liveQuery(async () => {
      const [savedArticles, readArticles, readingProgress] = await Promise.all([
        ids.length > 0 ? db.savedArticles.where("articleId").anyOf(ids).toArray() : [],
        db.readArticles.toArray(),
        db.readingProgress.get(feedType),
      ]);

      return {
        isLoaded: true,
        readArticleIds: new Set(readArticles.map((article) => article.articleId)),
        readingProgressArticleId: readingProgress?.articleId ?? null,
        savedArticleIds: new Set(savedArticles.map((article) => article.articleId)),
      } satisfies UserArticleStateSnapshot;
    }).subscribe({
      error: () => setSnapshot({ ...emptySnapshot, isLoaded: true }),
      next: setSnapshot,
    });

    return () => subscription.unsubscribe();
  }, [articleIdsKey, feedType]);

  return snapshot;
}
