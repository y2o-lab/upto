type ArticleWithId = {
  id: string;
};

export function excludeReadArticles<T extends ArticleWithId>(
  articles: readonly T[],
  readArticleIds: ReadonlySet<string>,
): T[] {
  return articles.filter((article) => !readArticleIds.has(article.id));
}
