import { GoogleGenAI, Type } from "@google/genai";
import { articleSummarySchema, type ArticleSummary } from "@upto/domain";
import { z } from "zod";

import { splitArticleIntoChunks } from "./content.js";
import { createGeminiRateLimiter, type GeminiRateLimiter } from "./gemini-rate-limiter.js";

export type ArticleToSummarize = {
  sourceName: string;
  title: string;
  url: string;
  publishedAt: Date | null;
  contentText: string;
  bookmarks: number;
  views: number;
};

export type Summarizer = {
  summarize(article: ArticleToSummarize): Promise<SummaryResult>;
};

export type SummaryResult = {
  modelId: string;
  summary: ArticleSummary;
};

export type GeminiClient = {
  models: Pick<GoogleGenAI["models"], "generateContent">;
};

export type GeminiSummarizerOptions = {
  apiKey: string;
  chunkSize: number;
  defaultModel: string;
  importantModel: string;
  maxRetries: number;
  requestsPerMinute: number;
  dependencies?: {
    ai?: GeminiClient;
    rateLimiter?: GeminiRateLimiter;
    random?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
    onRateLimitWait?: (details: { maxRequestsPerMinute: number; waitMilliseconds: number }) => void;
  };
};

const geminiSummarySchema = z.object({
  difficulty: z.enum(["beginner", "intermediate", "advanced"]).default("intermediate"),
  importance_score: z.number().int().min(1).max(100),
  key_points: z.array(z.string().min(1)).min(1).max(5),
  one_line_summary: z.string().min(1),
  summary: z.string().min(1),
  tags: z.array(z.string().min(1)).max(8).default([]),
  title: z.string().min(1),
  why_it_matters: z.string().min(1),
});

export function createGeminiSummarizer(options: GeminiSummarizerOptions): Summarizer {
  const ai = options.dependencies?.ai ?? new GoogleGenAI({ apiKey: options.apiKey });
  const sendRequest = createGeminiRequestSender({
    ai,
    maxRetries: options.maxRetries,
    random: options.dependencies?.random,
    rateLimiter:
      options.dependencies?.rateLimiter ??
      createGeminiRateLimiter({
        maxRequestsPerMinute: options.requestsPerMinute,
        onWait: options.dependencies?.onRateLimitWait,
      }),
    sleep: options.dependencies?.sleep,
  });

  return {
    async summarize(article) {
      const model = chooseModel(article, options.defaultModel, options.importantModel);
      try {
        return await summarizeWithModel(sendRequest, model, article, options.chunkSize);
      } catch (error) {
        if (model === options.defaultModel) {
          throw error;
        }

        return summarizeWithModel(sendRequest, options.defaultModel, article, options.chunkSize);
      }
    },
  };
}

export function createExtractiveSummarizer(): Summarizer {
  return {
    async summarize(article) {
      const sentences = article.contentText
        .split(/(?<=。|\.|!|\?)\s+/)
        .map((sentence) => sentence.trim())
        .filter(Boolean);
      const keyPoints = sentences.slice(0, 3);
      const summary = keyPoints.join("\n") || article.title;

      return {
        modelId: "extractive-fallback",
        summary: articleSummarySchema.parse({
          difficulty: "intermediate",
          importanceScore: Math.max(
            1,
            Math.min(100, Math.round(article.bookmarks || article.views || 1)),
          ),
          keyPoints: keyPoints.length > 0 ? keyPoints : [article.title],
          oneLineSummary: keyPoints[0] ?? article.title,
          summary,
          tags: [article.sourceName],
          title: article.title,
          whyItMatters:
            "本文から抽出した暫定要約です。Gemini APIキー設定後にAI要約へ置き換えられます。",
        }),
      };
    },
  };
}

function chooseModel(
  article: ArticleToSummarize,
  defaultModel: string,
  importantModel: string,
): string {
  return article.bookmarks >= 100 || article.views >= 100 ? importantModel : defaultModel;
}

async function requestChunkSummary(
  sendRequest: GeminiRequestSender,
  model: string,
  prompt: string,
): Promise<string> {
  const response = await sendRequest({
    config: {
      responseMimeType: "text/plain",
    },
    contents: prompt,
    model,
  });

  return readGeminiText(response.text).trim();
}

async function summarizeWithModel(
  sendRequest: GeminiRequestSender,
  model: string,
  article: ArticleToSummarize,
  chunkSize: number,
): Promise<SummaryResult> {
  const chunks = splitArticleIntoChunks(article.contentText, chunkSize);
  if (chunks.length === 0) {
    throw new Error("Cannot summarize an article without text.");
  }

  const onlyChunk = chunks[0];
  if (chunks.length === 1 && onlyChunk) {
    return {
      modelId: model,
      summary: await requestFinalSummary(sendRequest, model, buildFinalPrompt(article, onlyChunk)),
    };
  }

  const chunkSummaries = [];
  for (const [index, chunk] of chunks.entries()) {
    chunkSummaries.push(
      await requestChunkSummary(
        sendRequest,
        model,
        buildChunkPrompt(article, chunk, index + 1, chunks.length),
      ),
    );
  }

  return {
    modelId: model,
    summary: await requestFinalSummary(
      sendRequest,
      model,
      buildFinalPrompt(article, chunkSummaries.join("\n\n")),
    ),
  };
}

async function requestFinalSummary(
  sendRequest: GeminiRequestSender,
  model: string,
  prompt: string,
): Promise<ArticleSummary> {
  const response = await sendRequest({
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        properties: {
          difficulty: {
            enum: ["beginner", "intermediate", "advanced"],
            type: Type.STRING,
          },
          importance_score: {
            type: Type.INTEGER,
          },
          key_points: {
            items: { type: Type.STRING },
            type: Type.ARRAY,
          },
          one_line_summary: {
            type: Type.STRING,
          },
          summary: {
            type: Type.STRING,
          },
          tags: {
            items: { type: Type.STRING },
            type: Type.ARRAY,
          },
          title: {
            type: Type.STRING,
          },
          why_it_matters: {
            type: Type.STRING,
          },
        },
        required: [
          "title",
          "one_line_summary",
          "summary",
          "key_points",
          "why_it_matters",
          "tags",
          "difficulty",
          "importance_score",
        ],
        type: Type.OBJECT,
      },
    },
    contents: prompt,
    model,
  });

  const parsed = geminiSummarySchema.parse(
    JSON.parse(stripCodeFence(readGeminiText(response.text))),
  );
  return articleSummarySchema.parse({
    difficulty: parsed.difficulty,
    importanceScore: parsed.importance_score,
    keyPoints: parsed.key_points,
    oneLineSummary: parsed.one_line_summary,
    summary: parsed.summary,
    tags: parsed.tags,
    title: parsed.title,
    whyItMatters: parsed.why_it_matters,
  });
}

type GeminiGenerateContentRequest = Parameters<GoogleGenAI["models"]["generateContent"]>[0];
type GeminiRequestSender = (
  request: GeminiGenerateContentRequest,
) => ReturnType<GoogleGenAI["models"]["generateContent"]>;

type GeminiRequestSenderOptions = {
  ai: GeminiClient;
  maxRetries: number;
  random?: (() => number) | undefined;
  rateLimiter: GeminiRateLimiter;
  sleep?: ((milliseconds: number) => Promise<void>) | undefined;
};

function createGeminiRequestSender(options: GeminiRequestSenderOptions): GeminiRequestSender {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  return async (request) => {
    for (let attempt = 0; ; attempt += 1) {
      await options.rateLimiter.acquire();
      try {
        return await options.ai.models.generateContent(request);
      } catch (error) {
        if (!isGeminiRateLimitError(error) || attempt >= options.maxRetries) {
          throw error;
        }

        await sleep(retryAfterMilliseconds(error) ?? calculateBackoffMilliseconds(attempt, random));
      }
    }
  };
}

function isGeminiRateLimitError(error: unknown): boolean {
  return readErrorStatus(error) === 429;
}

function readErrorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  for (const candidate of [error.status, error.statusCode, readNestedStatus(error.response)]) {
    if (typeof candidate === "number") {
      return candidate;
    }
    if (typeof candidate === "string" && /^\d+$/.test(candidate)) {
      return Number(candidate);
    }
  }

  return undefined;
}

function readNestedStatus(value: unknown): unknown {
  return isRecord(value) ? value.status : undefined;
}

function retryAfterMilliseconds(error: unknown): number | undefined {
  if (!isRecord(error)) {
    return undefined;
  }

  const retryAfter =
    readHeader(error.headers, "retry-after") ?? readHeader(error.response, "retry-after");
  if (!retryAfter) {
    return undefined;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }

  const retryDate = Date.parse(retryAfter);
  return Number.isNaN(retryDate) ? undefined : Math.max(0, retryDate - Date.now());
}

function readHeader(value: unknown, name: string): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const headers = value.headers;
  if (
    headers &&
    typeof headers === "object" &&
    "get" in headers &&
    typeof headers.get === "function"
  ) {
    const header = headers.get(name);
    return typeof header === "string" ? header : undefined;
  }

  if (!isRecord(headers)) {
    return undefined;
  }

  for (const [key, header] of Object.entries(headers)) {
    if (key.toLowerCase() === name && typeof header === "string") {
      return header;
    }
  }
  return undefined;
}

function calculateBackoffMilliseconds(attempt: number, random: () => number): number {
  const cappedBackoff = Math.min(30_000, 1_000 * 2 ** attempt);
  return Math.round(cappedBackoff * (0.5 + random()));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function buildChunkPrompt(
  article: ArticleToSummarize,
  chunk: string,
  index: number,
  total: number,
): string {
  return `あなたは日本語ITニュースの編集者です。長文記事を分割要約するため、以下の記事チャンクだけを忠実に要約してください。

条件:
- 推測で補わず、チャンク内の事実だけを使う
- 固有名詞、技術名、数値、リリース名を残す
- 最終統合で使いやすいように、重要ポイントを箇条書き中心で返す
- 日本語で返す

記事:
- source: ${article.sourceName}
- title: ${article.title}
- url: ${article.url}
- chunk: ${index}/${total}

本文チャンク:
${chunk}`;
}

function buildFinalPrompt(article: ArticleToSummarize, contentOrChunkSummaries: string): string {
  return `あなたは日本語ITニュース要約アプリの編集者です。以下の記事本文またはチャンク要約を、読者が短時間で判断できる形式に統合してください。

出力条件:
- 必ずJSONだけを返す
- title は記事タイトルを日本語で自然に整える
- one_line_summary は80字以内の1文
- summary は3〜5行相当で、背景、何が変わるか、実務上の影響を含める
- key_points は3〜5個
- why_it_matters はITエンジニアが読む価値を1〜2文で説明する
- tags は最大8個
- difficulty は beginner / intermediate / advanced のいずれか
- importance_score は1〜100の整数
- 誇張や本文にない断定を避ける

期待JSON:
{
  "title": "記事タイトル",
  "one_line_summary": "1行要約",
  "summary": "3〜5行の要約",
  "key_points": ["重要ポイント1", "重要ポイント2", "重要ポイント3"],
  "why_it_matters": "なぜ重要か",
  "tags": ["AI", "TypeScript", "OSS"],
  "difficulty": "beginner | intermediate | advanced",
  "importance_score": 78
}

記事:
- source: ${article.sourceName}
- title: ${article.title}
- url: ${article.url}
- published_at: ${article.publishedAt?.toISOString() ?? "unknown"}
- bookmarks_or_score: ${article.bookmarks}
- comments_or_views: ${article.views}

本文またはチャンク要約:
${contentOrChunkSummaries}`;
}

function stripCodeFence(input: string): string {
  const trimmed = input.trim();
  return trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
}

function readGeminiText(text: string | undefined): string {
  if (!text) {
    throw new Error("Gemini returned an empty response.");
  }
  return text;
}
