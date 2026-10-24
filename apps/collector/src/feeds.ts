import { XMLParser } from "fast-xml-parser";

type RssFeedTarget = {
  kind: "rss";
  name: string;
  siteUrl: string;
  url: string;
};

type HackerNewsFeedTarget = {
  kind: "hacker-news";
  name: string;
  siteUrl: string;
  topStoriesUrl: string;
  itemUrlPrefix: string;
};

export type FeedTarget = RssFeedTarget | HackerNewsFeedTarget;

export type FeedItem = {
  title: string;
  url: string;
  publishedAt: Date | null;
  summaryText: string;
  contentHtml: string | null;
  bookmarks: number;
  views: number;
};

type FetchLike = typeof fetch;

const parser = new XMLParser({
  attributeNamePrefix: "@_",
  ignoreAttributes: false,
});

export const defaultFeedTargets: FeedTarget[] = [
  {
    kind: "rss",
    name: "Zenn",
    siteUrl: "https://zenn.dev",
    url: "https://zenn.dev/feed",
  },
  {
    kind: "rss",
    name: "Qiita",
    siteUrl: "https://qiita.com",
    url: "https://qiita.com/popular-items/feed",
  },
  {
    kind: "rss",
    name: "Hatena Bookmark IT",
    siteUrl: "https://b.hatena.ne.jp/hotentry/it",
    url: "https://b.hatena.ne.jp/hotentry/it.rss",
  },
  {
    itemUrlPrefix: "https://hacker-news.firebaseio.com/v0/item/",
    kind: "hacker-news",
    name: "Hacker News",
    siteUrl: "https://news.ycombinator.com",
    topStoriesUrl: "https://hacker-news.firebaseio.com/v0/topstories.json",
  },
  {
    kind: "rss",
    name: "GitHub Blog",
    siteUrl: "https://github.blog",
    url: "https://github.blog/feed/",
  },
];

export function feedEndpointUrl(feed: FeedTarget): string {
  return feed.kind === "rss" ? feed.url : feed.topStoriesUrl;
}

export async function fetchFeedItems(
  feed: FeedTarget,
  maxItems: number,
  fetcher: FetchLike = fetch,
): Promise<FeedItem[]> {
  if (feed.kind === "hacker-news") {
    return fetchHackerNewsItems(feed, maxItems, fetcher);
  }

  return fetchRssItems(feed, maxItems, fetcher);
}

async function fetchRssItems(
  feed: RssFeedTarget,
  maxItems: number,
  fetcher: FetchLike,
): Promise<FeedItem[]> {
  const xml = await fetchText(feed.url, fetcher);
  const document = parser.parse(xml) as Record<string, unknown>;
  const rssItems = readPath(document, ["rss", "channel", "item"]);
  const atomItems = readPath(document, ["feed", "entry"]);
  const rdfItems = readPath(document, ["rdf:RDF", "item"]);
  const rawItems = toArray(rssItems ?? atomItems ?? rdfItems);

  return rawItems
    .slice(0, maxItems)
    .map((raw) => parseRssOrAtomItem(raw))
    .filter((item): item is FeedItem => item !== null);
}

async function fetchHackerNewsItems(
  feed: HackerNewsFeedTarget,
  maxItems: number,
  fetcher: FetchLike,
): Promise<FeedItem[]> {
  const ids = (await fetchJson(feed.topStoriesUrl, fetcher)) as unknown;
  if (!Array.isArray(ids)) {
    throw new Error("Hacker News topstories response was not an array.");
  }

  const stories = await Promise.all(
    ids
      .slice(0, maxItems)
      .map(async (id) => fetchJson(`${feed.itemUrlPrefix}${String(id)}.json`, fetcher)),
  );

  return stories
    .map((raw) => parseHackerNewsItem(raw))
    .filter((item): item is FeedItem => item !== null);
}

async function fetchText(url: string, fetcher: FetchLike): Promise<string> {
  const response = await fetcher(url, {
    headers: {
      accept:
        "application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.8",
      "user-agent": "UptoCollector/0.1 (+https://github.com/inoueyuuya/upto)",
    },
  });

  if (!response.ok) {
    throw Object.assign(
      new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`),
      { status: response.status },
    );
  }

  return response.text();
}

async function fetchJson(url: string, fetcher: FetchLike): Promise<unknown> {
  const response = await fetcher(url, {
    headers: {
      accept: "application/json",
      "user-agent": "UptoCollector/0.1 (+https://github.com/inoueyuuya/upto)",
    },
  });

  if (!response.ok) {
    throw Object.assign(
      new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`),
      { status: response.status },
    );
  }

  return response.json();
}

function parseRssOrAtomItem(raw: unknown): FeedItem | null {
  if (!isRecord(raw)) {
    return null;
  }

  const title = toText(raw.title);
  const url = readLink(raw);
  if (!title || !url) {
    return null;
  }

  return {
    bookmarks: toNumber(raw["hatena:bookmarkcount"]) ?? 0,
    contentHtml: toText(raw["content:encoded"]) || toText(raw.content) || null,
    publishedAt: parseDate(
      toText(raw.pubDate) || toText(raw.published) || toText(raw.updated) || toText(raw["dc:date"]),
    ),
    summaryText: stripHtml(toText(raw.description) || toText(raw.summary) || ""),
    title,
    url,
    views: 0,
  };
}

function parseHackerNewsItem(raw: unknown): FeedItem | null {
  if (!isRecord(raw) || raw.type !== "story") {
    return null;
  }

  const title = toText(raw.title);
  const id = toNumber(raw.id);
  const url = toText(raw.url) || (id ? `https://news.ycombinator.com/item?id=${id}` : "");
  if (!title || !url) {
    return null;
  }

  const score = toNumber(raw.score) ?? 0;
  const descendants = toNumber(raw.descendants) ?? 0;

  return {
    bookmarks: score,
    contentHtml: null,
    publishedAt: parseUnixTime(toNumber(raw.time)),
    summaryText: "",
    title,
    url,
    views: descendants,
  };
}

function readLink(raw: Record<string, unknown>): string {
  const link = raw.link;
  if (typeof link === "string") {
    return link;
  }

  const atomLinks = toArray(link);
  for (const atomLink of atomLinks) {
    if (!isRecord(atomLink)) {
      continue;
    }

    const href = toText(atomLink["@_href"]);
    const rel = toText(atomLink["@_rel"]);
    if (href && (!rel || rel === "alternate")) {
      return href;
    }
  }

  return toText(raw.guid);
}

function readPath(input: unknown, path: string[]): unknown {
  let current = input;
  for (const key of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key];
  }
  return current;
}

function toArray(input: unknown): unknown[] {
  if (Array.isArray(input)) {
    return input;
  }
  return input === undefined || input === null ? [] : [input];
}

function toText(input: unknown): string {
  if (typeof input === "string") {
    return input.trim();
  }
  if (typeof input === "number") {
    return String(input);
  }
  if (isRecord(input) && typeof input["#text"] === "string") {
    return input["#text"].trim();
  }
  return "";
}

function toNumber(input: unknown): number | null {
  if (typeof input === "number" && Number.isFinite(input)) {
    return input;
  }
  if (typeof input === "string" && input.trim()) {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function parseDate(input: string): Date | null {
  if (!input) {
    return null;
  }
  const timestamp = Date.parse(input);
  return Number.isNaN(timestamp) ? null : new Date(timestamp);
}

function parseUnixTime(input: number | null): Date | null {
  return input === null ? null : new Date(input * 1000);
}

function stripHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null;
}
