import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";

import {
  getAppSetting,
  getReadingProgress,
  markArticleRead,
  markArticleSaved,
  pruneReadArticles,
  saveReadingProgress,
  setAppSetting,
  UptoUserStateDatabase,
} from "./user-state-db";

describe("UptoUserStateDatabase", () => {
  const dbs: UptoUserStateDatabase[] = [];

  afterEach(async () => {
    await Promise.all(
      dbs.splice(0).map(async (db) => {
        db.close();
        await db.delete();
      }),
    );
  });

  function createTestDb() {
    const dbName = `upto_user_state_test_${crypto.randomUUID()}`;
    const db = new UptoUserStateDatabase(dbName);
    dbs.push(db);
    return db;
  }

  it("stores saved articles, read articles, reading progress, and UI settings", async () => {
    const db = createTestDb();
    const savedAt = new Date("2026-06-15T00:00:00.000Z");
    const readAt = new Date("2026-06-15T00:00:03.000Z");
    const progressAt = new Date("2026-06-15T00:00:04.000Z");

    await markArticleSaved("article-1", true, savedAt, db);
    await markArticleRead("article-1", readAt, db);
    await saveReadingProgress("home", "article-1", progressAt, db);
    await setAppSetting("theme", "dark", db);

    await expect(db.savedArticles.get("article-1")).resolves.toEqual({
      articleId: "article-1",
      savedAt: "2026-06-15T00:00:00.000Z",
    });
    await expect(db.readArticles.get("article-1")).resolves.toEqual({
      articleId: "article-1",
      readAt: "2026-06-15T00:00:03.000Z",
    });
    await expect(getReadingProgress("home", db)).resolves.toEqual({
      articleId: "article-1",
      feedType: "home",
      updatedAt: "2026-06-15T00:00:04.000Z",
    });
    await expect(getAppSetting("theme", db)).resolves.toEqual({
      key: "theme",
      value: "dark",
    });

    db.close();
  });

  it("removes saved articles without deleting read state", async () => {
    const db = createTestDb();

    await markArticleSaved("article-1", true, new Date("2026-06-15T00:00:00.000Z"), db);
    await markArticleRead("article-1", new Date("2026-06-15T00:00:03.000Z"), db);
    await markArticleSaved("article-1", false, new Date("2026-06-15T00:00:05.000Z"), db);

    await expect(db.savedArticles.get("article-1")).resolves.toBeUndefined();
    await expect(db.readArticles.get("article-1")).resolves.toMatchObject({
      articleId: "article-1",
    });

    db.close();
  });

  it("keeps only recent read history up to the configured limit", async () => {
    const db = createTestDb();
    const now = new Date("2026-06-15T00:00:00.000Z");

    await markArticleRead("expired", new Date("2026-05-15T00:00:00.000Z"), db);
    await markArticleRead("oldest", new Date("2026-06-13T00:00:00.000Z"), db);
    await markArticleRead("middle", new Date("2026-06-14T00:00:00.000Z"), db);
    await markArticleRead("newest", now, db);

    await pruneReadArticles({ maxEntries: 2, now, retentionDays: 30 }, db);

    await expect(db.readArticles.orderBy("readAt").toArray()).resolves.toEqual([
      { articleId: "middle", readAt: "2026-06-14T00:00:00.000Z" },
      { articleId: "newest", readAt: "2026-06-15T00:00:00.000Z" },
    ]);
  });
  it("updates existing saved, read, and progress records without duplicating them", async () => {
    const db = createTestDb();
    const first = new Date("2026-06-15T00:00:00.000Z");
    const later = new Date("2026-06-16T00:00:00.000Z");
    for (const now of [first, later]) {
      await markArticleSaved("article-1", true, now, db);
      await markArticleRead("article-1", now, db);
      await saveReadingProgress("home", now === first ? "article-1" : "article-2", now, db);
    }
    expect(await db.savedArticles.toArray()).toEqual([
      { articleId: "article-1", savedAt: later.toISOString() },
    ]);
    expect(await db.readArticles.toArray()).toEqual([
      { articleId: "article-1", readAt: later.toISOString() },
    ]);
    expect(await db.readingProgress.toArray()).toEqual([
      { feedType: "home", articleId: "article-2", updatedAt: later.toISOString() },
    ]);
  });

  it("retains read history exactly at the expiry cutoff and removes older records", async () => {
    const db = createTestDb();
    await markArticleRead("expired", new Date("2026-06-14T23:59:59.999Z"), db);
    await markArticleRead("boundary", new Date("2026-06-15T00:00:00.000Z"), db);
    await pruneReadArticles({ now: new Date("2026-06-16T00:00:00.000Z"), retentionDays: 1 }, db);
    expect(await db.readArticles.toArray()).toEqual([
      { articleId: "boundary", readAt: "2026-06-15T00:00:00.000Z" },
    ]);
  });

  it("clears read history for a zero entry limit without deleting saved articles", async () => {
    const db = createTestDb();
    const now = new Date();
    await markArticleSaved("article-1", true, now, db);
    await markArticleRead("article-1", now, db);
    await pruneReadArticles({ maxEntries: 0, now }, db);
    expect(await db.readArticles.count()).toBe(0);
    expect(await db.savedArticles.count()).toBe(1);
  });

  it("keeps feed progress independent and updates settings", async () => {
    const db = createTestDb();
    const now = new Date();
    await saveReadingProgress("home", "article-1", now, db);
    await saveReadingProgress("bookmarks", "article-2", now, db);
    expect((await getReadingProgress("home", db))?.articleId).toBe("article-1");
    expect((await getReadingProgress("bookmarks", db))?.articleId).toBe("article-2");
    expect(await getReadingProgress("missing", db)).toBeUndefined();
    expect(await getAppSetting("theme", db)).toBeUndefined();
    await setAppSetting("theme", "light", db);
    await setAppSetting("theme", "dark", db);
    expect(await db.appSettings.toArray()).toEqual([{ key: "theme", value: "dark" }]);
  });

  it("allows reads and writes to complete when no database is available", async () => {
    const now = new Date();
    await expect(markArticleSaved("article-1", true, now, null)).resolves.toBeUndefined();
    await expect(markArticleRead("article-1", now, null)).resolves.toBeUndefined();
    await expect(saveReadingProgress("home", "article-1", now, null)).resolves.toBeUndefined();
    await expect(setAppSetting("theme", "dark", null)).resolves.toBeUndefined();
    await expect(pruneReadArticles({}, null)).resolves.toBeUndefined();
    await expect(getReadingProgress("home", null)).resolves.toBeUndefined();
    await expect(getAppSetting("theme", null)).resolves.toBeUndefined();
  });
});
