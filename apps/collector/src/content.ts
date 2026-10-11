import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";

import { createSafeFetcher } from "./http/safe-fetch.js";

export type ExtractedContent = {
  contentHtml: string | null;
  contentText: string;
  status: "extracted" | "fallback" | "failed";
};

type FetchLike = typeof fetch;
const safeFetch = createSafeFetcher();

export async function extractArticleContent(
  url: string,
  fallbackText: string,
  fallbackHtml: string | null,
  fetcher: FetchLike = safeFetch,
): Promise<ExtractedContent> {
  if (isEnoughText(fallbackText)) {
    return {
      contentHtml: fallbackHtml,
      contentText: fallbackText,
      status: "fallback",
    };
  }

  try {
    const response = await fetcher(url, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "UptoCollector/0.1 (+https://github.com/inoueyuuya/upto)",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch article HTML: ${response.status} ${response.statusText}`);
    }

    const html = await response.text();
    const dom = new JSDOM(html, { url });
    const parsed = new Readability(dom.window.document).parse();
    const contentText = normalizeWhitespace(parsed?.textContent ?? "");

    if (isEnoughText(contentText)) {
      return {
        contentHtml: parsed?.content ?? html,
        contentText,
        status: "extracted",
      };
    }
  } catch {
    // Fall through to the RSS/API fallback. Article-level failures are recorded by the caller.
  }

  const fallback = normalizeWhitespace(fallbackText || stripHtml(fallbackHtml ?? ""));
  return {
    contentHtml: fallbackHtml,
    contentText: fallback,
    status: fallback ? "fallback" : "failed",
  };
}

export function splitArticleIntoChunks(text: string, maxChunkChars: number): string[] {
  const normalized = normalizeWhitespace(text);
  if (normalized.length <= maxChunkChars) {
    return normalized ? [normalized] : [];
  }

  const paragraphs = normalized.split(/\n{2,}|(?<=。)\s+/);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    if (!paragraph) {
      continue;
    }

    if (paragraph.length > maxChunkChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      chunks.push(...splitLongParagraph(paragraph, maxChunkChars));
      continue;
    }

    const next = current ? `${current}\n\n${paragraph}` : paragraph;
    if (next.length > maxChunkChars) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = next;
    }
  }

  if (current) {
    chunks.push(current);
  }

  return chunks;
}

function splitLongParagraph(text: string, maxChunkChars: number): string[] {
  const chunks: string[] = [];
  for (let start = 0; start < text.length; start += maxChunkChars) {
    chunks.push(text.slice(start, start + maxChunkChars));
  }
  return chunks;
}

function isEnoughText(text: string): boolean {
  return normalizeWhitespace(text).length >= 800;
}

function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripHtml(input: string): string {
  return input
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
