import { describe, expect, it } from "vitest";

import { prioritizeUnreadArticles } from "./article-feed-order";

type TestArticle = {
  id: string;
};

const articles = ["a", "b", "c", "d"].map((id) => ({ id })) satisfies TestArticle[];

describe("prioritizeUnreadArticles", () => {
  it("places unread articles before read articles without changing either group's order", () => {
    const result = prioritizeUnreadArticles(articles, new Set(["a", "c"]));

    expect(result.map((article) => article.id)).toEqual(["b", "d", "a", "c"]);
  });

  it("keeps the existing algorithm order when every article is read", () => {
    const result = prioritizeUnreadArticles(articles, new Set(["a", "b", "c", "d"]));

    expect(result.map((article) => article.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps the existing algorithm order when every article is unread", () => {
    const result = prioritizeUnreadArticles(articles, new Set());

    expect(result.map((article) => article.id)).toEqual(["a", "b", "c", "d"]);
  });
});
