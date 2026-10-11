import { describe, expect, it } from "vitest";

import { resultWriteSchema } from "./results.js";

const input = {
  output: { kind: "chunk", text: "架空要約" },
  effectiveModel: "fixture-model",
  usage: { inputTokens: 10, outputTokens: 5 },
};
describe("persisted generation result validation", () => {
  it("accepts validated chunk text without prompt or raw Gemini fields", () => {
    expect(resultWriteSchema.parse(input)).toEqual(input);
    expect(resultWriteSchema.safeParse({ ...input, rawResponse: "private" }).success).toBe(false);
    expect(
      resultWriteSchema.safeParse({ ...input, output: { ...input.output, prompt: "private" } })
        .success,
    ).toBe(false);
  });
  it.each(["", "   ", "x".repeat(32769)])("rejects empty or unbounded chunk text", (text) => {
    expect(resultWriteSchema.safeParse({ ...input, output: { kind: "chunk", text } }).success).toBe(
      false,
    );
  });
  it.each([-1, 1.5, NaN, Infinity])("rejects invalid token usage %s", (inputTokens) => {
    expect(
      resultWriteSchema.safeParse({ ...input, usage: { inputTokens, outputTokens: 5 } }).success,
    ).toBe(false);
  });
  it("requires the complete summary contract and refuses arbitrary result shapes", () => {
    expect(
      resultWriteSchema.safeParse({
        ...input,
        output: { kind: "summary", summary: { title: "架空記事" } },
      }).success,
    ).toBe(false);
    expect(
      resultWriteSchema.safeParse({ ...input, output: { kind: "anything", body: "raw" } }).success,
    ).toBe(false);
  });
});
