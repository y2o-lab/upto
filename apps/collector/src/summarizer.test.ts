import { describe, expect, it, vi } from "vitest";

import type { GeminiClient, GeminiSummarizerOptions } from "./summarizer.js";

import { createGeminiSummarizer } from "./summarizer.js";

const article = {
  bookmarks: 10,
  contentText: "本文です。",
  publishedAt: new Date("2026-08-18T00:00:00.000Z"),
  sourceName: "Example",
  title: "Gemini rate limit test",
  url: "https://example.com/articles/rate-limit",
  views: 0,
};

const finalSummary = JSON.stringify({
  difficulty: "intermediate",
  importance_score: 42,
  key_points: ["ポイント1", "ポイント2", "ポイント3"],
  one_line_summary: "Geminiのリクエスト制御を検証する。",
  summary: "要約本文です。",
  tags: ["Gemini"],
  title: "Gemini rate limit test",
  why_it_matters: "API利用上限を守るために重要です。",
});

describe("createGeminiSummarizer", () => {
  it("counts a normal final-summary request through the shared limiter", async () => {
    const { generateContent, limiter, summarizer } = createTestSummarizer();

    await summarizer.summarize(article);

    expect(limiter.acquire).toHaveBeenCalledOnce();
    expect(generateContent).toHaveBeenCalledOnce();
  });

  it("counts every long-article chunk and its final integration through the same limiter", async () => {
    const { generateContent, limiter, summarizer } = createTestSummarizer({ chunkSize: 10 });

    await summarizer.summarize({
      ...article,
      contentText: "a".repeat(25),
    });

    expect(limiter.acquire).toHaveBeenCalledTimes(4);
    expect(generateContent).toHaveBeenCalledTimes(4);
    expect(generateContent.mock.calls.map(([request]) => request.model)).toEqual([
      "default-model",
      "default-model",
      "default-model",
      "default-model",
    ]);
  });

  it("counts an important-model fallback request through the same limiter", async () => {
    const { generateContent, limiter, summarizer } = createTestSummarizer({
      generateContent: vi
        .fn()
        .mockRejectedValueOnce(new Error("important model unavailable"))
        .mockResolvedValueOnce({ text: finalSummary }),
    });

    await summarizer.summarize({ ...article, bookmarks: 100 });

    expect(limiter.acquire).toHaveBeenCalledTimes(2);
    expect(generateContent.mock.calls.map(([request]) => request.model)).toEqual([
      "important-model",
      "default-model",
    ]);
  });

  it("retries HTTP 429 after Retry-After and counts the retry through the limiter", async () => {
    const sleep = vi.fn(async () => undefined);
    const { generateContent, limiter, summarizer } = createTestSummarizer({
      generateContent: vi
        .fn()
        .mockRejectedValueOnce({ response: { headers: { "retry-after": "3" }, status: 429 } })
        .mockResolvedValueOnce({ text: finalSummary }),
      sleep,
    });

    await summarizer.summarize(article);

    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(limiter.acquire).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(3_000);
  });

  it("uses jittered exponential backoff when a 429 response has no Retry-After", async () => {
    const sleep = vi.fn(async () => undefined);
    const { generateContent, limiter, summarizer } = createTestSummarizer({
      generateContent: vi
        .fn()
        .mockRejectedValueOnce({ status: 429 })
        .mockResolvedValueOnce({ text: finalSummary }),
      random: () => 0,
      sleep,
    });

    await summarizer.summarize(article);

    expect(generateContent).toHaveBeenCalledTimes(2);
    expect(limiter.acquire).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("stops retrying a 429 after the configured number of additional attempts", async () => {
    const sleep = vi.fn(async () => undefined);
    const rateLimitError = { status: 429 };
    const { generateContent, limiter, summarizer } = createTestSummarizer({
      generateContent: vi.fn().mockRejectedValue(rateLimitError),
      maxRetries: 2,
      sleep,
    });

    await expect(summarizer.summarize(article)).rejects.toBe(rateLimitError);

    expect(generateContent).toHaveBeenCalledTimes(3);
    expect(limiter.acquire).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-429 errors", async () => {
    const sleep = vi.fn(async () => undefined);
    const { generateContent, limiter, summarizer } = createTestSummarizer({
      generateContent: vi.fn().mockRejectedValue(new Error("service unavailable")),
      sleep,
    });

    await expect(summarizer.summarize(article)).rejects.toThrow("service unavailable");

    expect(generateContent).toHaveBeenCalledOnce();
    expect(limiter.acquire).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });
});

function createTestSummarizer(
  overrides: {
    chunkSize?: number;
    generateContent?: ReturnType<typeof vi.fn>;
    maxRetries?: number;
    random?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
) {
  const generateContent =
    overrides.generateContent ??
    vi.fn(async (request: { config: { responseMimeType: string } }) => ({
      text: request.config.responseMimeType === "text/plain" ? "チャンク要約" : finalSummary,
    }));
  const limiter = {
    acquire: vi.fn(async () => undefined),
    requestStartTimes: () => [],
  };
  const options: GeminiSummarizerOptions = {
    apiKey: "not-used-in-tests",
    chunkSize: overrides.chunkSize ?? 100,
    defaultModel: "default-model",
    dependencies: {
      ai: { models: { generateContent } } as unknown as GeminiClient,
      ...(overrides.random ? { random: overrides.random } : {}),
      rateLimiter: limiter,
      ...(overrides.sleep ? { sleep: overrides.sleep } : {}),
    },
    importantModel: "important-model",
    maxRetries: overrides.maxRetries ?? 2,
    requestsPerMinute: 5,
  };

  return {
    generateContent,
    limiter,
    summarizer: createGeminiSummarizer(options),
  };
}
