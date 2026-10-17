// @vitest-environment jsdom
import "fake-indexeddb/auto";
import type * as DexieModule from "dexie";

import { liveQuery } from "dexie";
import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type * as UserStateDbModule from "./user-state-db";

import {
  useSavedArticleIds,
  useUserArticleState,
  type SavedArticleIdsSnapshot,
  type UserArticleStateSnapshot,
} from "./use-user-article-state";
import {
  getUserStateDb,
  markArticleRead,
  markArticleSaved,
  pruneReadArticles,
  saveReadingProgress,
  UptoUserStateDatabase,
} from "./user-state-db";

vi.mock("dexie", async (importOriginal) => {
  const actual = await importOriginal<typeof DexieModule>();
  return {
    ...actual,
    liveQuery: vi.fn((querier: () => unknown) => {
      const observable = actual.liveQuery(querier);
      vi.spyOn(observable, "subscribe");
      return observable;
    }),
  };
});

vi.mock("./user-state-db", async (importOriginal) => {
  const actual = await importOriginal<typeof UserStateDbModule>();
  return {
    ...actual,
    getUserStateDb: vi.fn(),
    pruneReadArticles: vi.fn(actual.pruneReadArticles),
  };
});

let db: UptoUserStateDatabase;
let root: Root;
let container: HTMLDivElement;
let userState: UserArticleStateSnapshot;
let savedState: SavedArticleIdsSnapshot;

function UserStateProbe({ ids, feedType }: { ids: string[]; feedType: string }) {
  const snapshot = useUserArticleState(ids, feedType);
  useEffect(() => {
    userState = snapshot;
  }, [snapshot]);
  return null;
}

function SavedStateProbe() {
  const snapshot = useSavedArticleIds();
  useEffect(() => {
    savedState = snapshot;
  }, [snapshot]);
  return null;
}

// Flush Dexie's asynchronous live queries and React updates before checking the snapshot.
async function eventually(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assertion();
  });
}

async function renderUserState(ids = ["article-1"], feedType = "home") {
  await act(async () => {
    root.render(createElement(UserStateProbe, { ids, feedType }));
  });
}

async function renderSavedState() {
  await act(async () => {
    root.render(createElement(SavedStateProbe));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  db = new UptoUserStateDatabase(`hook_test_${crypto.randomUUID()}`);
  vi.mocked(getUserStateDb).mockReturnValue(db);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  db.close();
  await db.delete();
});

describe("useUserArticleState", () => {
  it("loads matching saved IDs, all read IDs, and progress for the requested feed", async () => {
    await markArticleSaved("article-1", true, new Date(), db);
    await markArticleSaved("other", true, new Date(), db);
    await markArticleRead("other", new Date(), db);
    await saveReadingProgress("home", "article-1", new Date(), db);
    await saveReadingProgress("bookmarks", "other", new Date(), db);
    await renderUserState();
    await eventually(() =>
      expect(userState).toEqual({
        isLoaded: true,
        readArticleIds: new Set(["other"]),
        savedArticleIds: new Set(["article-1"]),
        readingProgressArticleId: "article-1",
      }),
    );
  });

  it("reacts to saved, read, and progress updates", async () => {
    await renderUserState();
    await eventually(() => expect(userState.isLoaded).toBe(true));
    await act(async () => {
      await markArticleSaved("article-1", true, new Date(), db);
      await markArticleRead("article-1", new Date(), db);
      await saveReadingProgress("home", "article-1", new Date(), db);
    });
    await eventually(() => {
      expect(userState.savedArticleIds).toEqual(new Set(["article-1"]));
      expect(userState.readArticleIds).toEqual(new Set(["article-1"]));
      expect(userState.readingProgressArticleId).toBe("article-1");
    });
    await act(async () => markArticleSaved("article-1", false, new Date(), db));
    await eventually(() => expect(userState.savedArticleIds.size).toBe(0));
  });

  it("switches saved IDs and progress when article IDs and feed change", async () => {
    await markArticleSaved("article-1", true, new Date(), db);
    await markArticleSaved("article-2", true, new Date(), db);
    await saveReadingProgress("bookmarks", "article-2", new Date(), db);
    await renderUserState();
    await eventually(() => expect(userState.savedArticleIds).toEqual(new Set(["article-1"])));
    await renderUserState(["article-2"], "bookmarks");
    await eventually(() => {
      expect(userState.savedArticleIds).toEqual(new Set(["article-2"]));
      expect(userState.readingProgressArticleId).toBe("article-2");
    });
    await renderUserState([], "home");
    await eventually(() => {
      expect(userState.savedArticleIds.size).toBe(0);
      expect(userState.readingProgressArticleId).toBeNull();
    });
  });

  it("finishes loading when IndexedDB is unavailable", async () => {
    vi.mocked(getUserStateDb).mockReturnValue(null);
    await renderUserState();
    expect(userState).toEqual({
      isLoaded: true,
      savedArticleIds: new Set(),
      readArticleIds: new Set(),
      readingProgressArticleId: null,
    });
    expect(liveQuery).not.toHaveBeenCalled();
  });

  it("finishes loading with an empty state when history pruning fails", async () => {
    vi.mocked(pruneReadArticles).mockRejectedValueOnce(new Error("storage unavailable"));
    await renderUserState();
    await eventually(() =>
      expect(userState).toEqual({
        isLoaded: true,
        savedArticleIds: new Set(),
        readArticleIds: new Set(),
        readingProgressArticleId: null,
      }),
    );
    expect(liveQuery).not.toHaveBeenCalled();
  });

  it("finishes loading with an empty state when a live query fails", async () => {
    vi.spyOn(db.readingProgress, "get").mockRejectedValue(new Error("read failed"));
    await renderUserState();
    await eventually(() =>
      expect(userState).toEqual({
        isLoaded: true,
        savedArticleIds: new Set(),
        readArticleIds: new Set(),
        readingProgressArticleId: null,
      }),
    );
  });

  it("does not subscribe if unmounted while history pruning is pending", async () => {
    let finishPruning!: () => void;
    vi.mocked(pruneReadArticles).mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishPruning = resolve;
      }),
    );
    await renderUserState();
    expect(userState.isLoaded).toBe(false);
    await act(async () => root.render(null));
    await act(async () => finishPruning());
    expect(liveQuery).not.toHaveBeenCalled();
  });
});

describe("useSavedArticleIds", () => {
  it("loads saved IDs newest first and reacts to removal", async () => {
    await markArticleSaved("older", true, new Date("2026-06-01T00:00:00Z"), db);
    await markArticleSaved("newer", true, new Date("2026-06-02T00:00:00Z"), db);
    await renderSavedState();
    await eventually(() =>
      expect(savedState).toEqual({ isLoaded: true, savedArticleIds: ["newer", "older"] }),
    );
    await act(async () => markArticleSaved("newer", false, new Date(), db));
    await eventually(() => expect(savedState.savedArticleIds).toEqual(["older"]));
  });

  it("finishes loading when IndexedDB is unavailable", async () => {
    vi.mocked(getUserStateDb).mockReturnValue(null);
    await renderSavedState();
    expect(savedState).toEqual({ isLoaded: true, savedArticleIds: [] });
    expect(liveQuery).not.toHaveBeenCalled();
  });

  it("finishes loading with an empty list when a live query fails", async () => {
    const collection = db.savedArticles.orderBy("savedAt");
    vi.spyOn(collection, "toArray").mockRejectedValue(new Error("read failed"));
    vi.spyOn(db.savedArticles, "orderBy").mockReturnValue(collection);
    await renderSavedState();
    await eventually(() => expect(savedState).toEqual({ isLoaded: true, savedArticleIds: [] }));
  });
});

describe("subscription cleanup", () => {
  it.each(["user", "saved"])("unsubscribes the %s hook on unmount", async (kind) => {
    if (kind === "user") {
      await renderUserState();
      await eventually(() => expect(userState.isLoaded).toBe(true));
    } else {
      await renderSavedState();
      await eventually(() => expect(savedState.isLoaded).toBe(true));
    }
    const observable = vi.mocked(liveQuery).mock.results[0]!.value;
    const subscription = vi.mocked(observable.subscribe).mock.results[0]!.value;
    const unsubscribe = vi.spyOn(subscription, "unsubscribe");
    await act(async () => root.render(null));
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
