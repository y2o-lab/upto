import {
  referenceIdSchema,
  environmentSchema,
  extractionSnapshotSchema,
  type BatchEnvironment,
} from "@upto/domain/batch";
import { and, asc, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

import type { DbClient } from "../client.js";

import {
  collectorGenerations as generations,
  collectorChunks as chunks,
  collectorCandidates as candidates,
  collectorDiscoveries as discoveries,
  collectorPayloads as payloads,
} from "./schema.js";
export class SummaryInputRepository {
  constructor(private readonly db: DbClient) {}
  async chunk(reference: {
    environment: BatchEnvironment;
    generationId: string;
    chunkId: string;
    jobId: string;
    configVersion: string;
    executorVersion: string;
    promptVersion: string;
    schemaVersion: string;
  }) {
    environmentSchema.parse(reference.environment);
    for (const id of [reference.generationId, reference.chunkId, reference.jobId])
      referenceIdSchema.parse(id);
    const [row] = await this.db
      .select({ generation: generations, chunk: chunks, payload: payloads })
      .from(generations)
      .innerJoin(chunks, eq(chunks.generationId, generations.id))
      .innerJoin(payloads, eq(payloads.generationId, generations.id))
      .where(
        and(
          eq(generations.environment, reference.environment),
          eq(generations.id, reference.generationId),
          eq(chunks.id, reference.chunkId),
        ),
      );
    if (
      !row ||
      row.generation.configVersion !== reference.configVersion ||
      row.generation.promptVersion !== reference.promptVersion ||
      row.generation.schemaVersion !== reference.schemaVersion
    )
      throw new Error("SUMMARY_REFERENCE_MISMATCH");
    const [candidate] = await this.db
      .select({ id: candidates.id })
      .from(candidates)
      .innerJoin(discoveries, eq(discoveries.id, candidates.discoveryId))
      .where(
        and(
          eq(discoveries.environment, reference.environment),
          eq(discoveries.jobId, reference.jobId),
          eq(discoveries.configVersion, reference.configVersion),
          eq(discoveries.executorVersion, reference.executorVersion),
          eq(candidates.articleId, row.generation.articleId),
          eq(candidates.disposition, "process"),
          sql`${candidates.metadata} ->> 'generationId' = ${row.generation.id}`,
        ),
      )
      .limit(1);
    if (!candidate) throw new Error("SUMMARY_REFERENCE_MISMATCH");
    if (createHash("sha256").update(row.chunk.payload).digest("hex") !== row.chunk.inputHash)
      throw new Error("SUMMARY_INPUT_INTEGRITY_MISMATCH");
    const stored = await this.db
      .select()
      .from(chunks)
      .where(eq(chunks.generationId, row.generation.id))
      .orderBy(asc(chunks.index))
      .limit(65);
    const snapshot = extractionSnapshotSchema.safeParse({
      generationId: row.generation.id,
      contentText: row.payload.contentText,
      contentHtml: row.payload.contentHtml,
      extractionStatus: row.payload.extractionStatus,
      chunkerVersion: row.payload.chunkerVersion,
      chunks: stored.map((chunk) => chunk.payload),
    });
    if (
      !snapshot.success ||
      stored.some(
        (chunk, index) =>
          chunk.index !== index ||
          createHash("sha256").update(chunk.payload).digest("hex") !== chunk.inputHash,
      ) ||
      createHash("sha256").update(JSON.stringify(snapshot.data)).digest("hex") !==
        row.payload.contentHash ||
      row.generation.inputHash !== row.payload.contentHash
    )
      throw new Error("SUMMARY_INPUT_INTEGRITY_MISMATCH");
    if (
      stored.length < 1 ||
      stored.length > 64 ||
      row.chunk.index < 0 ||
      row.chunk.index >= stored.length
    )
      throw new Error("SUMMARY_REFERENCE_MISMATCH");
    return { generation: row.generation, chunk: row.chunk, chunkCount: stored.length };
  }
}
