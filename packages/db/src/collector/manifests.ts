import {
  manifestSnapshotSchema,
  manifestEntrySchema,
  manifestQuerySchema,
  MAX_CONTROL_RESPONSE_BYTES,
  type ManifestSnapshot,
  type ManifestEntry,
  type BatchEnvironment,
} from "@upto/domain/batch";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { DbClient } from "../client.js";
import type { DbTransaction } from "./operations.js";

import {
  collectorManifests as manifests,
  collectorManifestEntries as entries,
  collectorCandidates as candidates,
  collectorDiscoveries as discoveries,
  collectorChunks as chunks,
  collectorGenerations as generations,
  collectorResults as results,
  collectorOperations as operations,
} from "./schema.js";

export class ManifestRepository {
  private readonly cursorKey: Buffer;
  constructor(
    private readonly db: DbClient,
    cursorKey: Uint8Array,
  ) {
    if (cursorKey.byteLength < 32) throw new Error("CURSOR_KEY_INVALID");
    this.cursorKey = Buffer.from(cursorKey);
  }
  async create(input: ManifestSnapshot): Promise<void> {
    await this.db.transaction((tx) => this.createInTransaction(tx, input));
  }
  async createInTransaction(tx: DbTransaction, raw: ManifestSnapshot): Promise<void> {
    const input = manifestSnapshotSchema.parse(raw);
    const snapshotHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const [saved] = await tx.select().from(manifests).where(eq(manifests.id, input.id));
    if (saved) {
      if (saved.environment !== input.environment || saved.snapshotHash !== snapshotHash)
        throw new Error("MANIFEST_SNAPSHOT_CONFLICT");
      return;
    }
    if (input.kind !== "candidates") {
      const [parent] = await tx
        .select({ id: generations.id })
        .from(generations)
        .where(
          and(
            eq(generations.id, input.generationId),
            eq(generations.environment, input.environment),
          ),
        );
      if (!parent) throw new Error("MANIFEST_REFERENCE_MISMATCH");
    }
    if (input.kind === "candidates") {
      const [discovery] = await tx
        .select()
        .from(discoveries)
        .where(
          and(
            eq(discoveries.id, input.discoveryId),
            eq(discoveries.environment, input.environment),
          ),
        );
      if (!discovery) throw new Error("MANIFEST_REFERENCE_MISMATCH");
      if (new Set(input.entries.map((entry) => entry.candidateId)).size !== input.entries.length)
        throw new Error("MANIFEST_DUPLICATE_ENTRY");
      if (input.entries.length) {
        const owned = await tx
          .select()
          .from(candidates)
          .where(
            and(
              eq(candidates.discoveryId, input.discoveryId),
              inArray(
                candidates.id,
                input.entries.map((entry) => entry.candidateId),
              ),
            ),
          );
        if (
          owned.length !== input.entries.length ||
          input.entries.some(
            (entry) =>
              !owned.some(
                (row) => row.id === entry.candidateId && row.disposition === entry.disposition,
              ),
          )
        )
          throw new Error("MANIFEST_REFERENCE_MISMATCH");
        for (const entry of input.entries) {
          const candidate = owned.find((row) => row.id === entry.candidateId)!;
          if (
            entry.feedJobId &&
            (entry.feedJobId !== discovery.feedJobId ||
              entry.feedJobId !== candidate.metadata.feedJobId)
          )
            throw new Error("MANIFEST_REFERENCE_MISMATCH");
          if (
            entry.disposition === "failed" &&
            (!entry.errorCode ||
              entry.errorCode !== candidate.metadata.errorCode ||
              entry.generationId)
          )
            throw new Error("MANIFEST_REFERENCE_MISMATCH");
          if (entry.disposition !== "failed" && entry.errorCode)
            throw new Error("MANIFEST_REFERENCE_MISMATCH");
          if (entry.generationId) {
            const [generation] = await tx
              .select()
              .from(generations)
              .where(
                and(
                  eq(generations.id, entry.generationId),
                  eq(generations.environment, input.environment),
                ),
              );
            if (
              !generation ||
              generation.articleId !== candidate.articleId ||
              entry.disposition !== "process" ||
              entry.generationId !== candidate.metadata.generationId
            )
              throw new Error("MANIFEST_REFERENCE_MISMATCH");
          }
        }
      }
    } else if (input.entries.length && input.kind === "chunks") {
      const owned = await tx
        .select()
        .from(chunks)
        .where(
          and(
            eq(chunks.generationId, input.generationId),
            inArray(
              chunks.id,
              input.entries.map((entry) => entry.chunkId),
            ),
          ),
        );
      if (
        owned.length !== input.entries.length ||
        input.entries.some(
          (entry) =>
            !owned.some(
              (row) =>
                row.id === entry.chunkId &&
                row.index === entry.index &&
                row.inputHash === entry.inputHash,
            ),
        )
      )
        throw new Error("MANIFEST_REFERENCE_MISMATCH");
    } else if (input.entries.length && input.kind === "results") {
      const owned = await tx
        .select({ id: results.id, outputHash: results.outputHash })
        .from(results)
        .innerJoin(
          operations,
          and(
            eq(operations.environment, results.environment),
            eq(operations.operationKey, results.operationKey),
            eq(operations.status, "succeeded"),
          ),
        )
        .where(
          and(
            eq(results.environment, input.environment),
            eq(results.generationId, input.generationId),
            inArray(
              results.id,
              input.entries.map((entry) => entry.resultId),
            ),
          ),
        );
      if (
        new Set(input.entries.map((entry) => entry.resultId)).size !== input.entries.length ||
        owned.length !== input.entries.length ||
        input.entries.some(
          (entry) =>
            !owned.some((row) => row.id === entry.resultId && row.outputHash === entry.inputHash),
        )
      )
        throw new Error("MANIFEST_REFERENCE_MISMATCH");
    }
    const [inserted] = await tx
      .insert(manifests)
      .values({
        id: input.id,
        environment: input.environment,
        kind: input.kind,
        generationId: input.kind === "candidates" ? null : input.generationId,
        discoveryId: input.kind === "candidates" ? input.discoveryId : null,
        snapshotHash,
        entryCount: input.entries.length,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) {
      const [existing] = await tx.select().from(manifests).where(eq(manifests.id, input.id));
      if (
        !existing ||
        existing.environment !== input.environment ||
        existing.snapshotHash !== snapshotHash
      )
        throw new Error("MANIFEST_SNAPSHOT_CONFLICT");
      return;
    }
    if (input.entries.length)
      await tx
        .insert(entries)
        .values(input.entries.map((data, position) => ({ manifestId: input.id, position, data })));
  }
  private encodeCursor(environment: BatchEnvironment, manifestId: string, after: number): string {
    const payload = Buffer.from(
      JSON.stringify(["cursor-v1", environment, manifestId, after]),
    ).toString("base64url");
    return `${payload}.${createHmac("sha256", this.cursorKey).update(payload).digest("hex")}`;
  }
  private decodeCursor(value: string, environment: BatchEnvironment, manifestId: string): number {
    const parts = value.split(".");
    if (
      parts.length !== 2 ||
      !parts[0] ||
      !/^[A-Za-z0-9_-]+$/.test(parts[0]) ||
      !parts[1] ||
      !/^[a-f0-9]{64}$/.test(parts[1])
    )
      throw new Error("MANIFEST_CURSOR_INVALID");
    const signature = createHmac("sha256", this.cursorKey).update(parts[0]).digest();
    if (!timingSafeEqual(signature, Buffer.from(parts[1], "hex")))
      throw new Error("MANIFEST_CURSOR_INVALID");
    let decoded: unknown;
    try {
      decoded = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    } catch {
      throw new Error("MANIFEST_CURSOR_INVALID");
    }
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 4 ||
      decoded[0] !== "cursor-v1" ||
      decoded[1] !== environment ||
      decoded[2] !== manifestId ||
      !Number.isInteger(decoded[3]) ||
      decoded[3] < 0 ||
      decoded[3] > 99
    )
      throw new Error("MANIFEST_CURSOR_INVALID");
    return decoded[3];
  }
  async page(raw: {
    apiVersion: "v1";
    environment: BatchEnvironment;
    manifestId: string;
    limit: number;
    cursor?: string;
  }): Promise<{ manifestId: string; entries: ManifestEntry[]; nextCursor: string | null }> {
    const input = manifestQuerySchema.parse(raw);
    const after = input.cursor
      ? this.decodeCursor(input.cursor, input.environment, input.manifestId)
      : -1;
    const [manifest] = await this.db
      .select()
      .from(manifests)
      .where(and(eq(manifests.id, input.manifestId), eq(manifests.environment, input.environment)));
    if (!manifest) throw new Error("MANIFEST_NOT_FOUND");
    if (after >= manifest.entryCount) throw new Error("MANIFEST_CURSOR_INVALID");
    const rows = await this.db
      .select()
      .from(entries)
      .where(
        and(
          eq(entries.manifestId, input.manifestId),
          gt(entries.position, after),
          sql`${entries.position} < ${manifest.entryCount}`,
        ),
      )
      .orderBy(asc(entries.position))
      .limit(input.limit);
    if (
      rows.some((row, index) => row.position !== after + 1 + index) ||
      rows.length !== Math.min(input.limit, manifest.entryCount - after - 1)
    )
      throw new Error("MANIFEST_SNAPSHOT_CORRUPT");
    const values = rows.map((row) => manifestEntrySchema.parse(row.data));
    const last = rows.at(-1)?.position ?? after;
    const response = {
      manifestId: manifest.id,
      entries: values,
      nextCursor:
        last + 1 < manifest.entryCount
          ? this.encodeCursor(input.environment, manifest.id, last)
          : null,
    };
    if (Buffer.byteLength(JSON.stringify(response)) > MAX_CONTROL_RESPONSE_BYTES)
      throw new Error("MANIFEST_RESPONSE_TOO_LARGE");
    return response;
  }
}
