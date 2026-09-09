import Dexie, { type Table } from "dexie";

export type SavedArticle = {
  articleId: string;
  savedAt: string;
};

export type ReadArticle = {
  articleId: string;
  readAt: string;
};

export type ReadingProgress = {
  feedType: string;
  articleId: string;
  updatedAt: string;
};

export type AppSettingKey = "theme";

export type AppSetting = {
  key: AppSettingKey;
  value: string;
};

export type PruneReadArticlesOptions = {
  maxEntries?: number;
  now?: Date;
  retentionDays?: number;
};

const defaultReadArticleMaxEntries = 10_000;
const defaultReadArticleRetentionDays = 30;

export class UptoUserStateDatabase extends Dexie {
  appSettings: Table<AppSetting, AppSettingKey>;
  readArticles: Table<ReadArticle, string>;
  readingProgress: Table<ReadingProgress, string>;
  savedArticles: Table<SavedArticle, string>;

  constructor(databaseName = "upto_user_state") {
    super(databaseName);
    this.version(1).stores({
      app_settings: "key",
      read_articles: "articleId, readAt",
      reading_progress: "feedType, articleId, updatedAt",
      saved_articles: "articleId, savedAt",
    });

    this.appSettings = this.table("app_settings");
    this.readArticles = this.table("read_articles");
    this.readingProgress = this.table("reading_progress");
    this.savedArticles = this.table("saved_articles");
  }
}

let userStateDb: UptoUserStateDatabase | null = null;

export function getUserStateDb(): UptoUserStateDatabase | null {
  if (typeof indexedDB === "undefined") {
    return null;
  }

  userStateDb ??= new UptoUserStateDatabase();
  return userStateDb;
}

export async function markArticleSaved(
  articleId: string,
  isSaved: boolean,
  now = new Date(),
  db = getUserStateDb(),
): Promise<void> {
  if (!db) {
    return;
  }

  if (!isSaved) {
    await db.savedArticles.delete(articleId);
    return;
  }

  await db.savedArticles.put({
    articleId,
    savedAt: now.toISOString(),
  });
}

export async function markArticleRead(
  articleId: string,
  now = new Date(),
  db = getUserStateDb(),
): Promise<void> {
  if (!db) {
    return;
  }

  await db.readArticles.put({
    articleId,
    readAt: now.toISOString(),
  });
}

export async function pruneReadArticles(
  options: PruneReadArticlesOptions = {},
  db = getUserStateDb(),
): Promise<void> {
  if (!db) {
    return;
  }

  const now = options.now ?? new Date();
  const retentionDays = options.retentionDays ?? defaultReadArticleRetentionDays;
  const maxEntries = options.maxEntries ?? defaultReadArticleMaxEntries;
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000).toISOString();
  const expiredArticleIds = await db.readArticles.where("readAt").below(cutoff).primaryKeys();
  await db.readArticles.bulkDelete(expiredArticleIds);

  const retainedArticleIds = await db.readArticles.orderBy("readAt").primaryKeys();
  if (retainedArticleIds.length > maxEntries) {
    await db.readArticles.bulkDelete(
      retainedArticleIds.slice(0, retainedArticleIds.length - maxEntries),
    );
  }
}

export async function saveReadingProgress(
  feedType: string,
  articleId: string,
  now = new Date(),
  db = getUserStateDb(),
): Promise<void> {
  if (!db) {
    return;
  }

  await db.readingProgress.put({
    articleId,
    feedType,
    updatedAt: now.toISOString(),
  });
}

export async function getReadingProgress(
  feedType: string,
  db = getUserStateDb(),
): Promise<ReadingProgress | undefined> {
  if (!db) {
    return undefined;
  }

  return db.readingProgress.get(feedType);
}

export async function setAppSetting(
  key: AppSettingKey,
  value: string,
  db = getUserStateDb(),
): Promise<void> {
  if (!db) {
    return;
  }

  await db.appSettings.put({ key, value });
}

export async function getAppSetting(
  key: AppSettingKey,
  db = getUserStateDb(),
): Promise<AppSetting | undefined> {
  if (!db) {
    return undefined;
  }

  return db.appSettings.get(key);
}
