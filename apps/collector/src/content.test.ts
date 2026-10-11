import { describe, expect, it, vi } from "vitest";

import { extractArticleContent } from "./content.js";

describe("article extraction transport", () => {
  it("rejects private article fetches while preserving the feed fallback", async () => {
    const unrestricted = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(""));
    try {
      expect(await extractArticleContent("https://127.0.0.1/article", "架空の短文", null)).toEqual({
        contentText: "架空の短文",
        contentHtml: null,
        status: "fallback",
      });
      expect(unrestricted).not.toHaveBeenCalled();
    } finally {
      unrestricted.mockRestore();
    }
  });
  it("extracts readable HTML using an injected fixture transport", async () => {
    const paragraph = "架空の技術記事です。本文を抽出して保存するためのテストを行います。";
    const text = paragraph.repeat(40);
    const result = await extractArticleContent(
      "https://fixture.example/article",
      "",
      null,
      async () =>
        new Response(
          `<html><head><title>架空の記事</title></head><body><article><h1>架空の記事</h1><p>${text}</p></article></body></html>`,
        ),
    );
    expect(result.status).toBe("extracted");
    expect(result.contentText).toContain(text);
    expect(result.contentHtml).toContain("<p>");
  });
});
