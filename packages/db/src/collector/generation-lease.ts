import type { BatchEnvironment, OperationOutput } from "@upto/domain/batch";

import { and, eq, sql } from "drizzle-orm";

import type { DbTransaction } from "./database-types.js";

import {
  collectorGenerations as generations,
  collectorOperations as operations,
  collectorApiAttempts as attempts,
} from "./schema.js";
type GenerationRow = typeof generations.$inferSelect;
type OperationRow = typeof operations.$inferSelect;
export async function lockGeneration(
  tx: DbTransaction,
  environment: BatchEnvironment,
  id: string,
): Promise<GenerationRow> {
  const [row] = await tx
    .select()
    .from(generations)
    .where(and(eq(generations.id, id), eq(generations.environment, environment)))
    .for("update");
  if (!row) throw new Error("GENERATION_REFERENCE_MISMATCH");
  return row;
}
export async function markGenerationUncertain(
  tx: DbTransaction,
  operation: OperationRow,
): Promise<void> {
  if (!operation.generationId) return;
  await tx
    .update(generations)
    .set({ status: "uncertain", leaseOwner: null, leaseUntil: null })
    .where(
      and(
        eq(generations.id, operation.generationId),
        eq(generations.environment, operation.environment),
        sql`${generations.status} IN ('pending', 'running', 'waiting', 'uncertain')`,
      ),
    );
}
export async function acquireGeneration(
  tx: DbTransaction,
  row: GenerationRow,
  owner: string,
  leaseMs: number,
): Promise<
  | { status: "claimed"; epoch: number }
  | { status: "running"; leaseUntil: string }
  | { status: "uncertain" }
> {
  if (row.status === "uncertain") return { status: "uncertain" };
  if (!["pending", "running", "waiting"].includes(row.status))
    throw new Error("GENERATION_TERMINAL");
  const [live] = await tx
    .select({ leaseUntil: operations.leaseUntil })
    .from(operations)
    .where(
      and(
        eq(operations.environment, row.environment),
        eq(operations.generationId, row.id),
        eq(operations.status, "running"),
        sql`${operations.leaseUntil} > clock_timestamp()`,
      ),
    )
    .orderBy(sql`${operations.leaseUntil} DESC`)
    .limit(1);
  if (live?.leaseUntil) return { status: "running", leaseUntil: live.leaseUntil.toISOString() };
  const [timing] = await tx
    .select({ live: sql<boolean>`${generations.leaseUntil} > clock_timestamp()` })
    .from(generations)
    .where(eq(generations.id, row.id));
  if (row.status === "running" && timing?.live && row.leaseUntil)
    return { status: "running", leaseUntil: row.leaseUntil.toISOString() };
  const [unresolved] = await tx
    .select({ key: operations.operationKey })
    .from(operations)
    .innerJoin(
      attempts,
      and(
        eq(operations.environment, attempts.environment),
        eq(operations.operationKey, attempts.operationKey),
      ),
    )
    .where(
      and(
        eq(operations.environment, row.environment),
        eq(operations.generationId, row.id),
        sql`${attempts.status} IN ('sent', 'uncertain')`,
      ),
    )
    .limit(1);
  if (unresolved) {
    await tx
      .update(generations)
      .set({ status: "uncertain", leaseOwner: null, leaseUntil: null })
      .where(eq(generations.id, row.id));
    return { status: "uncertain" };
  }
  const [updated] = await tx
    .update(generations)
    .set({
      status: "running",
      leaseOwner: owner,
      leaseEpoch: sql`${generations.leaseEpoch} + 1`,
      leaseUntil: sql`clock_timestamp() + (${leaseMs} * interval '1 millisecond')`,
    })
    .where(and(eq(generations.id, row.id), eq(generations.leaseEpoch, row.leaseEpoch)))
    .returning();
  if (!updated) throw new Error("STALE_GENERATION_OWNER");
  return { status: "claimed", epoch: updated.leaseEpoch };
}
function generationFence(row: OperationRow) {
  if (row.generationId === null || row.generationEpoch === null || row.leaseOwner === null)
    throw new Error("STALE_GENERATION_OWNER");
  return and(
    eq(generations.id, row.generationId),
    eq(generations.environment, row.environment),
    eq(generations.status, "running"),
    eq(generations.leaseEpoch, row.generationEpoch),
    eq(generations.leaseOwner, row.leaseOwner),
    sql`${generations.leaseUntil} > clock_timestamp()`,
  );
}
export async function assertGenerationOwner(tx: DbTransaction, row: OperationRow): Promise<void> {
  if (row.generationId === null) return;
  const [owned] = await tx
    .select({ id: generations.id })
    .from(generations)
    .where(generationFence(row));
  if (!owned) throw new Error("STALE_GENERATION_OWNER");
}
export async function releaseGeneration(
  tx: DbTransaction,
  row: OperationRow,
  succeeded = false,
): Promise<void> {
  if (row.generationId === null) return;
  const [updated] = await tx
    .update(generations)
    .set({
      status: succeeded ? "succeeded" : "waiting",
      leaseOwner: null,
      leaseUntil: null,
      terminalAt: succeeded ? sql`clock_timestamp()` : null,
    })
    .where(generationFence(row))
    .returning();
  if (!updated) throw new Error("STALE_GENERATION_OWNER");
}

export async function assertPublishedGeneration(
  tx: DbTransaction,
  operation: OperationRow,
  output: OperationOutput,
): Promise<void> {
  if (operation.stage !== "persist" || operation.generationId === null) return;
  if (output.kind !== "stage" || output.response.stage !== "persist")
    throw new Error("GENERATION_PUBLICATION_REQUIRED");
  const publication = await tx.execute(sql`SELECT a.id FROM collector_generations g
    JOIN articles a ON a.id=g.article_id
    JOIN article_contents c ON c.article_id=a.id
    JOIN article_summaries s ON s.article_id=a.id
    JOIN article_metrics m ON m.article_id=a.id
    WHERE g.id=${operation.generationId} AND g.environment=${operation.environment}
    AND a.id=${output.response.articleId} AND a.summary_status='summarized'`);
  if (publication.rowCount !== 1) throw new Error("GENERATION_PUBLICATION_REQUIRED");
}
