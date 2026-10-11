import { describe, expect, it, vi } from "vitest";

import { fetchFeedItems, type FeedTarget } from "./feeds.js";

describe("fetchFeedItems", () => {
  it.each(["<rss><channel>", "<html><body>upstream error</body></html>", "not XML"])(
    "rejects invalid feed %s",
    async (body) => {
      await expect(
        fetchFeedItems(
          {
            kind: "rss",
            name: "fixture",
            siteUrl: "https://fixture.example",
            url: "https://fixture.example/feed",
          },
          1,
          async () => new Response(body),
        ),
      ).rejects.toThrow("FEED_XML_INVALID");
    },
  );
  it("accepts a valid empty feed", async () => {
    expect(
      await fetchFeedItems(
        {
          kind: "rss",
          name: "fixture",
          siteUrl: "https://fixture.example",
          url: "https://fixture.example/feed",
        },
        1,
        async () =>
          new Response('<rss version="2.0"><channel><title>fixture</title></channel></rss>'),
      ),
    ).toEqual([]);
  });
  it("rejects a private feed through the default transport before any global fetch", async () => {
    const unrestricted = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
    try {
      await expect(
        fetchFeedItems(
          {
            kind: "rss",
            name: "fixture",
            siteUrl: "https://127.0.0.1",
            url: "https://127.0.0.1/feed",
          },
          1,
        ),
      ).rejects.toThrow("FETCH_ADDRESS_REJECTED");
      expect(unrestricted).not.toHaveBeenCalled();
    } finally {
      unrestricted.mockRestore();
    }
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

it("bounds Hacker News item HTTP concurrency and continues after one failed item", async () => {
  const feed: FeedTarget = {
    kind: "hacker-news",
    name: "fixture",
    siteUrl: "https://fixture.example",
    topStoriesUrl: "https://fixture.example/top",
    itemUrlPrefix: "https://fixture.example/item/",
  };
  let active = 0;
  let peak = 0;
  const items = await fetchFeedItems(feed, 9, async (input) => {
    const url = String(input);
    if (url.endsWith("/top")) return new Response(JSON.stringify([1, 2, 3, 4, 5, 6, 7, 8, 9]));
    active++;
    peak = Math.max(peak, active);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (url.endsWith("/5.json")) return new Response(null, { status: 500 });
      return new Response(
        JSON.stringify({
          id: 1,
          type: "story",
          title: "fixture",
          url: "https://fixture.example/article",
        }),
      );
    } finally {
      active--;
    }
  });
  expect(peak).toBe(4);
  expect(active).toBe(0);
  expect(items).toHaveLength(8);
});

it("reports total Hacker News item transport failure instead of a successful empty feed", async () => {
  const feed: FeedTarget = {
    kind: "hacker-news",
    name: "fixture",
    siteUrl: "https://fixture.example",
    topStoriesUrl: "https://fixture.example/top",
    itemUrlPrefix: "https://fixture.example/item/",
  };
  await expect(
    fetchFeedItems(feed, 2, async (input) =>
      String(input).endsWith("/top") ? new Response("[1,2]") : new Response(null, { status: 503 }),
    ),
  ).rejects.toThrow("HN_ITEMS_FETCH_FAILED");
});
