import { expect, it } from "vitest";

import { extractionInputSchema, candidateExtractionMetadataSchema } from "./extraction.js";
const value = {
  url: "https://fixture.example/article",
  fallbackText: "架空本文",
  fallbackHtml: null,
  chunkChars: 12000,
  chunkerVersion: "1",
};
it("bounds immutable extraction input and rejects omitted fallback fields", () => {
  expect(extractionInputSchema.parse(value)).toEqual(value);
  expect(extractionInputSchema.safeParse({ ...value, chunkChars: 0 }).success).toBe(false);
  expect(
    extractionInputSchema.safeParse({ ...value, fallbackText: "あ".repeat(800000) }).success,
  ).toBe(false);
  expect(extractionInputSchema.safeParse({ ...value, secret: "fixture" }).success).toBe(false);
  expect(candidateExtractionMetadataSchema.safeParse({ summaryText: "架空" }).success).toBe(false);
});
