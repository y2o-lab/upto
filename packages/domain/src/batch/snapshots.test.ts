import { describe, expect, it } from "vitest";

import {
  extractionSnapshotSchema,
  manifestSnapshotSchema,
  MAX_EXTRACTION_BYTES,
  MAX_EXTRACTION_CHUNKS,
} from "./snapshots.js";
const id = "00000000-0000-4000-8000-000000000001";
const input = {
  generationId: id,
  contentText: "架空本文",
  contentHtml: null,
  extractionStatus: "extracted",
  chunkerVersion: "1",
  chunks: ["架空", "本文"],
};
describe("extraction snapshots", () => {
  it("requires complete chunk coverage while allowing paragraph boundary whitespace normalization", () => {
    expect(extractionSnapshotSchema.safeParse(input).success).toBe(true);
    expect(
      extractionSnapshotSchema.safeParse({
        ...input,
        contentText: "架空。\n\n本文",
        chunks: ["架空。", "本文"],
      }).success,
    ).toBe(true);
    expect(extractionSnapshotSchema.safeParse({ ...input, chunks: ["本文"] }).success).toBe(false);
    expect(extractionSnapshotSchema.safeParse({ ...input, chunks: ["本文", "架空"] }).success).toBe(
      false,
    );
  });
  it("bounds UTF-8 bytes and chunk count including equality", () => {
    const text = "x".repeat(MAX_EXTRACTION_BYTES);
    expect(
      extractionSnapshotSchema.safeParse({ ...input, contentText: text, chunks: [text] }).success,
    ).toBe(true);
    const over = "あ".repeat(Math.ceil(MAX_EXTRACTION_BYTES / 3));
    expect(
      extractionSnapshotSchema.safeParse({ ...input, contentText: over, chunks: [over] }).success,
    ).toBe(false);
    expect(
      extractionSnapshotSchema.safeParse({
        ...input,
        contentText: "x".repeat(MAX_EXTRACTION_CHUNKS),
        chunks: Array.from({ length: MAX_EXTRACTION_CHUNKS }, () => "x"),
      }).success,
    ).toBe(true);
    expect(
      extractionSnapshotSchema.safeParse({
        ...input,
        contentText: "x".repeat(MAX_EXTRACTION_CHUNKS + 1),
        chunks: Array.from({ length: MAX_EXTRACTION_CHUNKS + 1 }, () => "x"),
      }).success,
    ).toBe(false);
  });
  it("rejects failed/empty extraction and extra fields", () => {
    for (const changed of [
      { extractionStatus: "failed" },
      { contentText: "", chunks: [] },
      { prompt: "private" },
    ])
      expect(extractionSnapshotSchema.safeParse({ ...input, ...changed }).success).toBe(false);
  });
});
describe("manifest snapshot contracts", () => {
  it("rejects non-contiguous chunk indexes and wrong-kind references", () => {
    const value = {
      id,
      environment: "staging",
      kind: "chunks",
      generationId: id,
      entries: [{ chunkId: id, index: 0, inputHash: "a".repeat(64) }],
    };
    expect(manifestSnapshotSchema.safeParse(value).success).toBe(true);
    expect(
      manifestSnapshotSchema.safeParse({
        ...value,
        entries: [{ chunkId: id, index: 1, inputHash: "a".repeat(64) }],
      }).success,
    ).toBe(false);
    expect(
      manifestSnapshotSchema.safeParse({
        ...value,
        entries: [{ candidateId: id, disposition: "process" }],
      }).success,
    ).toBe(false);
  });
});
