import { describe, expect, it } from "vitest";

import { excludeReadArticles } from "./article-feed-order";

type TestArticle = {
  id: string;
};

const articles = ["a", "b", "c", "d"].map((id) => ({ id })) satisfies TestArticle[];

describe("excludeReadArticles", () => {
  it("removes read articles without changing unread article order", () => {
    const result = excludeReadArticles(articles, new Set(["a", "c"]));

    expect(result.map((article) => article.id)).toEqual(["b", "d"]);
  });

  it("returns an empty list when every article is read", () => {
    const result = excludeReadArticles(articles, new Set(["a", "b", "c", "d"]));

    expect(result).toEqual([]);
  });

  it("keeps the existing order when every article is unread", () => {
    const result = excludeReadArticles(articles, new Set());

    expect(result.map((article) => article.id)).toEqual(["a", "b", "c", "d"]);
  });
});
