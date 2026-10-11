import {
  environmentSchema,
  referenceIdSchema,
  publicationInputSchema,
  publicationCandidateMetadataSchema,
  extractionSnapshotSchema,
  storedSummaryJson,
  type BatchEnvironment,
  type OperationKeyInput,
} from "@upto/domain/batch";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { createHash } from "node:crypto";

import type { DbClient } from "../client.js";

import {
  articles,
  articleContents,
  articleSummaries,
  articleMetrics,
  crawlJobs,
  feedEndpoints,
} from "../schema-core.js";
import { OperationRepository, type OperationFence } from "./operations.js";
import { ResultRepository } from "./results.js";
import {
  collectorGenerations as generations,
  collectorPayloads as payloads,
  collectorChunks as chunks,
  collectorOperations as operations,
  collectorCandidates as candidates,
  collectorDiscoveries as discoveries,
} from "./schema.js";

export type PublicationReference = {
  environment: BatchEnvironment;
  generationId: string;
  finalResultId: string;
};
export class PublicationRepository {
  constructor(private readonly db: DbClient) {}
  async describe(input: PublicationReference, db: Pick<DbClient, "select"> = this.db) {
    environmentSchema.parse(input.environment);
    referenceIdSchema.parse(input.generationId);
    referenceIdSchema.parse(input.finalResultId);
    const [generation] = await db
      .select()
      .from(generations)
      .where(
        and(eq(generations.environment, input.environment), eq(generations.id, input.generationId)),
      );
    const [payload] = await db
      .select()
      .from(payloads)
      .where(eq(payloads.generationId, input.generationId));
    const result = await new ResultRepository(db).read(
      input.environment,
      input.finalResultId,
      input.generationId,
    );
    if (
      !generation ||
      !payload ||
      !result ||
      result.output.kind !== "summary" ||
      !["summarize-chunk", "merge-summary"].includes(result.stage)
    )
      throw new Error("PUBLICATION_REFERENCE_MISMATCH");
    if (
      result.promptVersion !== generation.promptVersion ||
      result.schemaVersion !== generation.schemaVersion ||
      generation.inputHash !== payload.contentHash
    )
      throw new Error("PUBLICATION_VERSION_MISMATCH");
    const storedChunks = await db
      .select()
      .from(chunks)
      .where(eq(chunks.generationId, generation.id))
      .orderBy(asc(chunks.index))
      .limit(65);
    if (
      storedChunks.length < 1 ||
      storedChunks.length > 64 ||
      (storedChunks.length > 1 && result.stage !== "merge-summary")
    )
      throw new Error("PUBLICATION_RESULT_INCOMPLETE");
    const snapshot = extractionSnapshotSchema.safeParse({
      generationId: generation.id,
      contentText: payload.contentText,
      contentHtml: payload.contentHtml,
      extractionStatus: payload.extractionStatus,
      chunkerVersion: payload.chunkerVersion,
      chunks: storedChunks.map((chunk) => chunk.payload),
    });
    if (
      !snapshot.success ||
      storedChunks.some(
        (chunk, index) =>
          chunk.index !== index ||
          createHash("sha256").update(chunk.payload).digest("hex") !== chunk.inputHash,
      ) ||
      createHash("sha256").update(JSON.stringify(snapshot.data)).digest("hex") !==
        payload.contentHash
    )
      throw new Error("PUBLICATION_VERSION_MISMATCH");
    const inputHash = createHash("sha256")
      .update(JSON.stringify([generation.id, result.id, result.outputHash, payload.contentHash]))
      .digest("hex");
    const identity: OperationKeyInput = {
      environment: input.environment,
      stage: "persist",
      logicalEntityId: `${generation.id}/${result.id}`,
      inputHash,
      model: "",
      promptVersion: generation.promptVersion,
      schemaVersion: generation.schemaVersion,
    };
    return { identity, generation, payload, result, summary: result.output.summary };
  }
  async incompletePublished(limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("INVALID_RECONCILIATION_LIMIT");
    return this.db
      .select({
        articleId: articles.id,
        missingContent: sql<boolean>`${articleContents.articleId} IS NULL`,
        missingSummary: sql<boolean>`${articleSummaries.articleId} IS NULL`,
        missingMetrics: sql<boolean>`${articleMetrics.articleId} IS NULL`,
      })
      .from(articles)
      .leftJoin(articleContents, eq(articleContents.articleId, articles.id))
      .leftJoin(articleSummaries, eq(articleSummaries.articleId, articles.id))
      .leftJoin(articleMetrics, eq(articleMetrics.articleId, articles.id))
      .where(
        and(
          eq(articles.summaryStatus, "summarized"),
          or(
            sql`${articleContents.articleId} IS NULL`,
            sql`${articleSummaries.articleId} IS NULL`,
            sql`${articleMetrics.articleId} IS NULL`,
          ),
        ),
      )
      .orderBy(asc(articles.id))
      .limit(limit);
  }
  async metricsFor(
    input: PublicationReference & {
      jobId: string;
      feedJobId: string;
      configVersion: string;
      executorVersion: string;
    },
  ) {
    referenceIdSchema.parse(input.jobId);
    referenceIdSchema.parse(input.feedJobId);
    const snapshot = await this.describe(input);
    const [candidate] = await this.db
      .select({ metadata: candidates.metadata })
      .from(candidates)
      .innerJoin(discoveries, eq(discoveries.id, candidates.discoveryId))
      .innerJoin(articles, eq(articles.id, candidates.articleId))
      .where(
        and(
          eq(discoveries.environment, input.environment),
          eq(discoveries.jobId, input.jobId),
          eq(discoveries.configVersion, input.configVersion),
          eq(discoveries.executorVersion, input.executorVersion),
          eq(candidates.articleId, snapshot.generation.articleId),
          eq(candidates.disposition, "process"),
          sql`(NOT (${candidates.metadata} ? 'generationId') OR ${candidates.metadata} ->> 'generationId' = ${input.generationId})`,
          eq(candidates.normalizedUrl, articles.normalizedUrl),
          sql`${candidates.metadata} ->> 'feedJobId' = ${input.feedJobId}`,
        ),
      )
      .limit(1);
    const metadata = publicationCandidateMetadataSchema.safeParse(candidate?.metadata);
    if (!metadata.success) throw new Error("PUBLICATION_REFERENCE_MISMATCH");
    const [job] = await this.db
      .select({ sourceId: feedEndpoints.sourceId })
      .from(crawlJobs)
      .innerJoin(feedEndpoints, eq(feedEndpoints.id, crawlJobs.feedEndpointId))
      .where(eq(crawlJobs.id, input.feedJobId));
    if (!job || job.sourceId !== metadata.data.sourceId)
      throw new Error("PUBLICATION_REFERENCE_MISMATCH");
    return {
      bookmarks: metadata.data.bookmarks,
      views: metadata.data.views,
      score: metadata.data.score,
    };
  }
  async publish(
    fence: OperationFence,
    raw: {
      generationId: string;
      finalResultId: string;
      metrics: { bookmarks: number; views: number; score: number };
    },
  ) {
    const input = publicationInputSchema.parse(raw);
    const response = {
      status: "succeeded" as const,
      stage: "persist" as const,
      articleId: "",
      publication: "published" as "published" | "alreadyPublished",
    };
    await new OperationRepository(this.db).complete(fence, async (tx) => {
      const snapshot = await this.describe(
        {
          environment: fence.environment,
          generationId: input.generationId,
          finalResultId: input.finalResultId,
        },
        tx,
      );
      const [operation] = await tx
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.environment, fence.environment),
            eq(operations.operationKey, fence.operationKey),
          ),
        );
      if (
        operation?.stage !== "persist" ||
        operation.generationId !== input.generationId ||
        operation.inputHash !== snapshot.identity.inputHash ||
        operation.logicalEntityId !== snapshot.identity.logicalEntityId
      )
        throw new Error("PUBLICATION_REFERENCE_MISMATCH");
      const [article] = await tx
        .select()
        .from(articles)
        .where(eq(articles.id, snapshot.generation.articleId))
        .for("update");
      if (!article) throw new Error("PUBLICATION_REFERENCE_MISMATCH");
      response.articleId = article.id;
      if (article.summaryStatus === "summarized") response.publication = "alreadyPublished";
      else {
        const content = {
          articleId: article.id,
          contentText: snapshot.payload.contentText,
          contentHtml: snapshot.payload.contentHtml,
          extractedAt: snapshot.payload.createdAt,
        };
        await tx
          .insert(articleContents)
          .values(content)
          .onConflictDoUpdate({ target: articleContents.articleId, set: content });
        const summary = {
          articleId: article.id,
          modelId: snapshot.result.effectiveModel,
          shortSummary: snapshot.summary.oneLineSummary,
          bullets: snapshot.summary.keyPoints,
          topics: snapshot.summary.tags,
          summaryJson: storedSummaryJson(snapshot.summary),
          summarizedAt: snapshot.result.createdAt,
        };
        await tx
          .insert(articleSummaries)
          .values(summary)
          .onConflictDoUpdate({ target: articleSummaries.articleId, set: summary });
      }
      const metrics = { articleId: article.id, ...input.metrics, measuredAt: new Date() };
      await tx
        .insert(articleMetrics)
        .values(metrics)
        .onConflictDoUpdate({ target: articleMetrics.articleId, set: metrics });
      if (response.publication === "published")
        await tx
          .update(articles)
          .set({
            title: snapshot.summary.title,
            summaryStatus: "summarized",
            fetchStatus: "fetched",
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(articles.id, article.id));
      return {
        output: { kind: "stage", response },
        effectiveModel: "",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    });
    return response;
  }
}
