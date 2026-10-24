import { describe, expect, it } from "vitest";

import { fetchFeedItems, type FeedTarget } from "./feeds.js";

describe("fetchFeedItems", () => {
  it("retains HTTP status for safe error notifications", async () => {
    await expect(
      fetchFeedItems(
        {
          kind: "rss",
          name: "Example",
          siteUrl: "https://example.com",
          url: "https://example.com/feed.xml",
        },
        1,
        async () => new Response("private upstream body", { status: 503 }),
      ),
    ).rejects.toMatchObject({ status: 503 });
  });
  it("parses RSS 1.0 RDF feeds such as Hatena Bookmark", async () => {
    const feed: FeedTarget = {
      kind: "rss",
      name: "Hatena Bookmark IT",
      siteUrl: "https://b.hatena.ne.jp/hotentry/it",
      url: "https://b.hatena.ne.jp/hotentry/it.rss",
    };
    const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
  xmlns="http://purl.org/rss/1.0/"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:hatena="http://www.hatena.ne.jp/info/xmlns#">
  <item rdf:about="https://example.com/article">
    <title>RSS 1.0 article</title>
    <link>https://example.com/article</link>
    <description>RSS 1.0 description</description>
    <dc:date>2026-06-07T00:00:00+09:00</dc:date>
    <hatena:bookmarkcount>123</hatena:bookmarkcount>
  </item>
</rdf:RDF>`;

    const items = await fetchFeedItems(feed, 1, async () => new Response(rss));

    expect(items).toEqual([
      {
        bookmarks: 123,
        contentHtml: null,
        publishedAt: new Date("2026-06-06T15:00:00.000Z"),
        summaryText: "RSS 1.0 description",
        title: "RSS 1.0 article",
        url: "https://example.com/article",
        views: 0,
      },
    ]);
  });

  it("parses Hacker News Firebase API stories", async () => {
    const feed: FeedTarget = {
      itemUrlPrefix: "https://hacker-news.firebaseio.com/v0/item/",
      kind: "hacker-news",
      name: "Hacker News",
      siteUrl: "https://news.ycombinator.com",
      topStoriesUrl: "https://hacker-news.firebaseio.com/v0/topstories.json",
    };
    const fetcher = async (url: string | URL | Request) => {
      const textUrl = String(url);
      if (textUrl.endsWith("topstories.json")) {
        return new Response(JSON.stringify([1]));
      }
      return new Response(
        JSON.stringify({
          descendants: 10,
          id: 1,
          score: 99,
          time: 1780790400,
          title: "HN story",
          type: "story",
          url: "https://example.com/hn",
        }),
      );
    };

    const items = await fetchFeedItems(feed, 1, fetcher as typeof fetch);

    expect(items).toEqual([
      {
        bookmarks: 99,
        contentHtml: null,
        publishedAt: new Date("2026-06-07T00:00:00.000Z"),
        summaryText: "",
        title: "HN story",
        url: "https://example.com/hn",
        views: 10,
      },
    ]);
  });
});
