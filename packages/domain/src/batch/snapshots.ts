import { z } from "zod";

import { environmentSchema, referenceIdSchema, hashSchema, errorCodeSchema } from "./contracts.js";
export const MAX_EXTRACTION_BYTES = 2 * 1024 * 1024;
export const MAX_EXTRACTION_CHUNKS = 64;
const boundedText = z
  .string()
  .min(1)
  .refine((text) => text.trim().length > 0)
  .max(MAX_EXTRACTION_BYTES)
  .refine((text) => new TextEncoder().encode(text).byteLength <= MAX_EXTRACTION_BYTES);
export const extractionSnapshotSchema = z
  .strictObject({
    generationId: referenceIdSchema,
    contentText: boundedText,
    contentHtml: z
      .string()
      .max(MAX_EXTRACTION_BYTES)
      .refine((text) => new TextEncoder().encode(text).byteLength <= MAX_EXTRACTION_BYTES)
      .nullable(),
    extractionStatus: z.enum(["extracted", "fallback"]),
    chunkerVersion: z.string().min(1).max(128),
    chunks: z.array(boundedText).min(1).max(MAX_EXTRACTION_CHUNKS),
  })
  .refine(
    (value) =>
      value.chunks.reduce(
        (total, chunk) => total + new TextEncoder().encode(chunk).byteLength,
        0,
      ) <=
        MAX_EXTRACTION_BYTES + MAX_EXTRACTION_CHUNKS * 2 &&
      value.chunks.join("").replace(/\s+/g, "") === value.contentText.replace(/\s+/g, ""),
    {
      message: "Chunks must exactly cover the stored content.",
    },
  );
export const candidateManifestEntrySchema = z.strictObject({
  candidateId: referenceIdSchema,
  disposition: z.enum(["process", "alreadyPublished", "failed"]),
  errorCode: errorCodeSchema.optional(),
  generationId: referenceIdSchema.optional(),
  feedJobId: referenceIdSchema.optional(),
});
export const chunkManifestEntrySchema = z.strictObject({
  chunkId: referenceIdSchema,
  index: z.number().int().nonnegative(),
  inputHash: hashSchema,
});
export const resultManifestEntrySchema = z.strictObject({
  resultId: referenceIdSchema,
  index: z.number().int().nonnegative(),
  inputHash: hashSchema,
});
export const manifestEntrySchema = z.union([
  candidateManifestEntrySchema,
  chunkManifestEntrySchema,
  resultManifestEntrySchema,
]);
const base = { id: referenceIdSchema, environment: environmentSchema };
export const manifestSnapshotSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      ...base,
      kind: z.literal("candidates"),
      discoveryId: referenceIdSchema,
      entries: z.array(candidateManifestEntrySchema).max(100),
    }),
    z.strictObject({
      ...base,
      kind: z.literal("chunks"),
      generationId: referenceIdSchema,
      entries: z.array(chunkManifestEntrySchema).max(MAX_EXTRACTION_CHUNKS),
    }),
    z.strictObject({
      ...base,
      kind: z.literal("results"),
      generationId: referenceIdSchema,
      entries: z.array(resultManifestEntrySchema).max(MAX_EXTRACTION_CHUNKS),
    }),
  ])
  .refine(
    (value) =>
      value.kind === "candidates" ||
      value.entries.every((entry, position) => entry.index === position),
    { message: "Manifest indexes must be contiguous and ordered." },
  );
export type ManifestSnapshot = z.infer<typeof manifestSnapshotSchema>;
export type ManifestEntry = z.infer<typeof manifestEntrySchema>;
