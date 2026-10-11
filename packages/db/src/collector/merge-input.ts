import {
  referenceIdSchema,
  manifestSnapshotSchema,
  type BatchEnvironment,
} from "@upto/domain/batch";
import { and, asc, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";

import type { DbClient } from "../client.js";
import type { DbTransaction } from "./database-types.js";

import { ManifestRepository } from "./manifests.js";
import { ResultRepository } from "./results.js";
import {
  collectorChunks as chunks,
  collectorGenerations as generations,
  collectorOperations as operations,
  collectorResults as results,
  collectorManifests as manifests,
  collectorManifestEntries as entries,
} from "./schema.js";
import { SummaryInputRepository } from "./summary-input.js";
export type MergeReference = {
  environment: BatchEnvironment;
  generationId: string;
  jobId: string;
  configVersion: string;
  executorVersion: string;
  promptVersion: string;
  schemaVersion: string;
};
export class MergeInputRepository {
  private readonly models: string[];
  constructor(
    private readonly db: DbClient,
    private readonly cursorKey: Uint8Array,
    models: string[],
  ) {
    if (!models.length || models.length > 2 || models.some((value) => !value || value.length > 128))
      throw new Error("GENERATION_CONFIG_INVALID");
    this.models = [...new Set(models)];
  }
  private async authorize(reference: MergeReference) {
    referenceIdSchema.parse(reference.generationId);
    const stored = await this.db
      .select()
      .from(chunks)
      .where(eq(chunks.generationId, reference.generationId))
      .orderBy(asc(chunks.index))
      .limit(65);
    if (!stored[0]) throw new Error("SUMMARY_REFERENCE_MISMATCH");
    const input = await new SummaryInputRepository(this.db).chunk({
      ...reference,
      chunkId: stored[0].id,
    });
    if (
      stored.length < 2 ||
      stored.length > 64 ||
      stored.length !== input.chunkCount ||
      stored.some(
        (chunk, index) =>
          chunk.index !== index ||
          createHash("sha256").update(chunk.payload).digest("hex") !== chunk.inputHash,
      )
    )
      throw new Error("SUMMARY_RESULTS_INCOMPLETE");
    return stored;
  }
  private async part(
    db: Pick<DbClient, "select">,
    reference: MergeReference,
    chunkId: string,
    resultId: string,
    index: number,
    expectedHash?: string,
  ) {
    const result = await new ResultRepository(db).read(
      reference.environment,
      resultId,
      reference.generationId,
    );
    if (
      !result ||
      result.stage !== "summarize-chunk" ||
      result.logicalEntityId !== `${reference.generationId}/${chunkId}` ||
      result.output.kind !== "chunk" ||
      result.promptVersion !== reference.promptVersion ||
      result.schemaVersion !== reference.schemaVersion ||
      !this.models.includes(result.effectiveModel) ||
      (expectedHash !== undefined && result.outputHash !== expectedHash)
    )
      throw new Error("SUMMARY_RESULTS_INCOMPLETE");
    return {
      resultId,
      index,
      inputHash: result.outputHash,
      text: result.output.text,
      model: result.effectiveModel,
    };
  }
  async createOrdered(reference: MergeReference) {
    const stored = await this.authorize(reference);
    return this.db.transaction(async (tx: DbTransaction) => {
      const [generation] = await tx
        .select()
        .from(generations)
        .where(
          and(
            eq(generations.environment, reference.environment),
            eq(generations.id, reference.generationId),
          ),
        )
        .for("update");
      if (!generation) throw new Error("SUMMARY_REFERENCE_MISMATCH");
      const snapshotEntries = [];
      for (const chunk of stored) {
        const [result] = await tx
          .select({ id: results.id })
          .from(results)
          .innerJoin(
            operations,
            and(
              eq(operations.environment, results.environment),
              eq(operations.operationKey, results.operationKey),
              eq(operations.resultId, results.id),
              eq(operations.status, "succeeded"),
            ),
          )
          .where(
            and(
              eq(results.environment, reference.environment),
              eq(results.generationId, reference.generationId),
              eq(operations.stage, "summarize-chunk"),
              eq(operations.logicalEntityId, `${reference.generationId}/${chunk.id}`),
              eq(operations.promptVersion, reference.promptVersion),
              eq(operations.schemaVersion, reference.schemaVersion),
              inArray(results.effectiveModel, this.models),
            ),
          )
          .orderBy(asc(results.createdAt), asc(results.id))
          .limit(1);
        if (!result) throw new Error("SUMMARY_RESULTS_INCOMPLETE");
        const part = await this.part(tx, reference, chunk.id, result.id, chunk.index);
        snapshotEntries.push({
          resultId: part.resultId,
          index: part.index,
          inputHash: part.inputHash,
        });
      }
      const hash = createHash("sha256")
        .update(JSON.stringify([reference.environment, reference.generationId, snapshotEntries]))
        .digest("hex");
      const uuidBytes = Buffer.from(hash.slice(0, 32), "hex");
      uuidBytes[6] = (uuidBytes[6]! & 15) | 128;
      uuidBytes[8] = (uuidBytes[8]! & 63) | 128;
      const hex = uuidBytes.toString("hex");
      const manifestId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
      await new ManifestRepository(this.db, this.cursorKey).createInTransaction(tx, {
        id: manifestId,
        environment: reference.environment,
        kind: "results",
        generationId: reference.generationId,
        entries: snapshotEntries,
      });
      return { manifestId, resultCount: snapshotEntries.length };
    });
  }
  async read(reference: MergeReference, manifestId: string) {
    referenceIdSchema.parse(manifestId);
    const stored = await this.authorize(reference);
    const [manifest] = await this.db
      .select()
      .from(manifests)
      .where(
        and(
          eq(manifests.environment, reference.environment),
          eq(manifests.id, manifestId),
          eq(manifests.generationId, reference.generationId),
          eq(manifests.kind, "results"),
        ),
      );
    if (!manifest) throw new Error("SUMMARY_REFERENCE_MISMATCH");
    const rows = await this.db
      .select()
      .from(entries)
      .where(eq(entries.manifestId, manifestId))
      .orderBy(asc(entries.position))
      .limit(65);
    const snapshot = manifestSnapshotSchema.safeParse({
      id: manifest.id,
      environment: reference.environment,
      kind: "results",
      generationId: reference.generationId,
      entries: rows.map((row) => row.data),
    });
    if (
      !snapshot.success ||
      snapshot.data.kind !== "results" ||
      manifest.entryCount !== stored.length ||
      rows.length !== stored.length ||
      rows.some((row, index) => row.position !== index) ||
      createHash("sha256").update(JSON.stringify(snapshot.data)).digest("hex") !==
        manifest.snapshotHash
    )
      throw new Error("SUMMARY_RESULTS_INCOMPLETE");
    const parts = [];
    for (const entry of snapshot.data.entries)
      parts.push(
        await this.part(
          this.db,
          reference,
          stored[entry.index]!.id,
          entry.resultId,
          entry.index,
          entry.inputHash,
        ),
      );
    const orderedResultsHash = createHash("sha256")
      .update(JSON.stringify(snapshot.data.entries))
      .digest("hex");
    return { generationId: reference.generationId, orderedResultsHash, parts };
  }
}
