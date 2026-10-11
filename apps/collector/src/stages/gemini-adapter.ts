import { ApiError, GoogleGenAI } from "@google/genai";
import { tokenUsageSchema } from "@upto/domain/batch";
import { z } from "zod";

import { GenerationTransportError, type GenerationDependencies } from "./generation-sender.js";
type GeminiClient = { models: Pick<GoogleGenAI["models"], "countTokens" | "generateContent"> };
export function createGeminiGenerationAdapter(options: {
  apiKey: string;
  ai?: GeminiClient;
}): Pick<GenerationDependencies, "count" | "generate"> {
  if (!options.apiKey.trim()) throw new Error("GEMINI_CONFIG_INVALID");
  const ai = options.ai ?? new GoogleGenAI({ apiKey: options.apiKey });
  return {
    async count(input) {
      try {
        const response = await ai.models.countTokens({
          model: input.model,
          contents: input.prompt,
          config: {
            abortSignal: input.signal,
            httpOptions: { timeout: 10000, retryOptions: { attempts: 1 } },
          },
        });
        return { inputTokens: z.number().int().min(1).max(1900000000).parse(response.totalTokens) };
      } catch {
        throw new Error("TOKEN_COUNT_UNAVAILABLE");
      }
    },
    async generate(input) {
      let response;
      try {
        response = await ai.models.generateContent({
          model: input.model,
          contents: input.prompt,
          config: {
            abortSignal: input.signal,
            httpOptions: { timeout: 180000, retryOptions: { attempts: 1 } },
            responseMimeType: "application/json",
            maxOutputTokens: input.maxOutputTokens,
            candidateCount: 1,
            automaticFunctionCalling: { disable: true },
          },
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 429)
          throw new GenerationTransportError("rate_limited");
        if (error instanceof ApiError && [400, 401, 403, 404, 422].includes(error.status))
          throw new GenerationTransportError("rejected");
        throw new Error("GEMINI_OUTCOME_UNKNOWN");
      }
      const metadata = response.usageMetadata;
      const usage = tokenUsageSchema.safeParse({
        inputTokens: metadata?.promptTokenCount,
        outputTokens:
          metadata?.totalTokenCount !== undefined && metadata.promptTokenCount !== undefined
            ? metadata.totalTokenCount - metadata.promptTokenCount
            : undefined,
      });
      const parts = response.candidates?.[0]?.content?.parts;
      const texts: string[] = [];
      let bytes = 0;
      let validText = !!parts?.length && parts.length <= 128;
      for (const part of parts ?? []) {
        if (part.thought) continue;
        if (
          typeof part.text !== "string" ||
          Object.keys(part).some((key) => !["text", "thought", "thoughtSignature"].includes(key))
        ) {
          validText = false;
          break;
        }
        bytes += new TextEncoder().encode(part.text).byteLength;
        if (bytes > 65536) {
          validText = false;
          break;
        }
        texts.push(part.text);
      }
      const text = texts.join("");
      let output: unknown = null;
      if (
        response.candidates?.length === 1 &&
        response.candidates[0]?.finishReason === "STOP" &&
        validText
      ) {
        try {
          output = JSON.parse(text);
        } catch {
          /* A completed invalid JSON response is validated as terminal failure by the sender. */
        }
      }
      return { output, usage: usage.success ? usage.data : null };
    },
  };
}
