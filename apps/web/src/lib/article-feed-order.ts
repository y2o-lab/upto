type ArticleWithId = {
  id: string;
};

export function prioritizeUnreadArticles<T extends ArticleWithId>(
  articles: readonly T[],
  readArticleIds: ReadonlySet<string>,
): T[] {
  const unreadArticles: T[] = [];
  const readArticles: T[] = [];

  for (const article of articles) {
    (readArticleIds.has(article.id) ? readArticles : unreadArticles).push(article);
  }

  return [...unreadArticles, ...readArticles];
}
