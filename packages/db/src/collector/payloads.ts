import {
  extractionSnapshotSchema,
  environmentSchema,
  referenceIdSchema,
  type BatchEnvironment,
} from "@upto/domain/batch";
import { and, eq, sql } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";

import type { DbClient } from "../client.js";

import { ManifestRepository } from "./manifests.js";
import { OperationRepository, type OperationFence } from "./operations.js";
import {
  collectorGenerations as generations,
  collectorPayloads as payloads,
  collectorChunks as chunks,
  collectorOperations as operations,
} from "./schema.js";

export type ExtractionSnapshotInput = {
  generationId: string;
  contentText: string;
  contentHtml: string | null;
  extractionStatus: "extracted" | "fallback";
  chunkerVersion: string;
  chunks: string[];
};
export class PayloadRepository {
  constructor(
    private readonly db: DbClient,
    private readonly cursorKey: Uint8Array,
  ) {}
  async extraction(environment: BatchEnvironment, generationId: string) {
    environmentSchema.parse(environment);
    referenceIdSchema.parse(generationId);
    const [value] = await this.db
      .select({ payload: payloads })
      .from(payloads)
      .innerJoin(generations, eq(generations.id, payloads.generationId))
      .where(and(eq(generations.environment, environment), eq(generations.id, generationId)));
    return value?.payload ?? null;
  }
  async chunk(environment: BatchEnvironment, generationId: string, chunkId: string) {
    environmentSchema.parse(environment);
    referenceIdSchema.parse(generationId);
    referenceIdSchema.parse(chunkId);
    const [value] = await this.db
      .select({ chunk: chunks })
      .from(chunks)
      .innerJoin(generations, eq(generations.id, chunks.generationId))
      .where(
        and(
          eq(generations.environment, environment),
          eq(generations.id, generationId),
          eq(chunks.id, chunkId),
        ),
      );
    return value?.chunk ?? null;
  }
  async saveExtraction(fence: OperationFence, raw: ExtractionSnapshotInput) {
    const input = extractionSnapshotSchema.parse(raw);
    const inputHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const contentId = randomUUID();
    const chunkManifestId = randomUUID();
    const chunkRows = input.chunks.map((payload, index) => ({
      id: randomUUID(),
      generationId: input.generationId,
      index,
      payload,
      inputHash: createHash("sha256").update(payload).digest("hex"),
    }));
    const response = {
      status: "succeeded" as const,
      stage: "extract" as const,
      contentId,
      chunkManifestId,
      chunkCount: chunkRows.length,
      inputHash,
    };
    await new OperationRepository(this.db).complete(
      fence,
      {
        output: { kind: "stage", response },
        effectiveModel: "",
        usage: { inputTokens: 0, outputTokens: 0 },
      },
      async (tx) => {
        const [operation] = await tx
          .select()
          .from(operations)
          .where(
            and(
              eq(operations.environment, fence.environment),
              eq(operations.operationKey, fence.operationKey),
            ),
          );
        const [generation] = await tx
          .select()
          .from(generations)
          .where(
            and(
              eq(generations.id, input.generationId),
              eq(generations.environment, fence.environment),
            ),
          )
          .for("update");
        if (
          !generation ||
          operation?.generationId !== input.generationId ||
          operation.stage !== "extract"
        )
          throw new Error("GENERATION_REFERENCE_MISMATCH");
        if (!["pending", "running", "waiting"].includes(generation.status))
          throw new Error("GENERATION_TERMINAL");
        const [inserted] = await tx
          .insert(payloads)
          .values({
            id: contentId,
            generationId: generation.id,
            contentText: input.contentText,
            contentHtml: input.contentHtml,
            extractionStatus: input.extractionStatus,
            contentHash: inputHash,
            chunkerVersion: input.chunkerVersion,
          })
          .onConflictDoNothing()
          .returning();
        if (!inserted) throw new Error("EXTRACTION_SNAPSHOT_CONFLICT");
        await tx.insert(chunks).values(chunkRows);
        await new ManifestRepository(this.db, this.cursorKey).createInTransaction(tx, {
          id: chunkManifestId,
          environment: fence.environment,
          kind: "chunks",
          generationId: generation.id,
          entries: chunkRows.map((row) => ({
            chunkId: row.id,
            index: row.index,
            inputHash: row.inputHash,
          })),
        });
        await tx
          .update(generations)
          .set({ inputHash })
          .where(
            and(
              eq(generations.id, generation.id),
              sql`${generations.status} IN ('pending', 'running', 'waiting')`,
            ),
          );
      },
    );
    return response;
  }
}
