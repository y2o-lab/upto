import { expect, it } from "vitest";

import { prepareDiscoveryCandidates } from "./discovery.js";
const item = {
  title: "架空記事",
  url: "https://fixture.example/article?utm_source=fixture",
  publishedAt: null,
  summaryText: "架空本文",
  contentHtml: null,
  bookmarks: 4,
  views: 10,
};
it("normalizes and deduplicates URL candidates while skipping invalid individual items", () => {
  const prepared = prepareDiscoveryCandidates(
    [
      item,
      { ...item, url: "https://fixture.example/article" },
      { ...item, url: "javascript:invalid" },
      { ...item, bookmarks: -1 },
    ],
    100,
    new Date("2026-10-11T00:00:00Z"),
  );
  expect(prepared).toHaveLength(1);
  expect(prepared[0]).toMatchObject({
    normalizedUrl: "https://fixture.example/article",
    score: 14,
  });
});
it("bounds candidate count and rejects invalid limits", () => {
  expect(
    prepareDiscoveryCandidates(
      Array.from({ length: 3 }, (_, i) => ({ ...item, url: `https://fixture.example/${i}` })),
      2,
      new Date(),
    ),
  ).toHaveLength(2);
  expect(() => prepareDiscoveryCandidates([], 101, new Date())).toThrow("DISCOVERY_LIMIT_INVALID");
});
