import { z } from "zod";

import { MAX_EXTRACTION_BYTES } from "./snapshots.js";

const text = z
  .string()
  .max(MAX_EXTRACTION_BYTES)
  .refine((value) => new TextEncoder().encode(value).byteLength <= MAX_EXTRACTION_BYTES);
export const extractionInputSchema = z.strictObject({
  url: z.url().max(4096),
  fallbackText: text,
  fallbackHtml: text.nullable(),
  chunkChars: z.number().int().min(1000).max(100000),
  chunkerVersion: z.string().min(1).max(128),
});
export const candidateExtractionMetadataSchema = z.object({
  summaryText: text,
  contentHtml: text.nullable(),
});
export type ExtractionInput = z.infer<typeof extractionInputSchema>;
