import {
  type BatchEnvironment,
  type DiscoveryCandidate,
  type OperationKeyInput,
  referenceIdSchema,
  environmentSchema,
  prepareDiscoveryCandidates,
} from "@upto/domain/batch";
import { and, eq, sql } from "drizzle-orm";
import { randomUUID, createHash } from "node:crypto";

import type { DbClient } from "../client.js";

import { articles, articleMetrics, sources, feedEndpoints, crawlJobs } from "../schema-core.js";
import { GenerationRepository, type GenerationJoin } from "./generations.js";
import { ManifestRepository } from "./manifests.js";
import { OperationRepository, type OperationFence } from "./operations.js";
import { ResultRepository } from "./results.js";
import {
  collectorDiscoveries as discoveries,
  collectorCandidates as candidates,
  collectorOperations as operations,
} from "./schema.js";
export type DiscoveryBinding = {
  environment: BatchEnvironment;
  jobId: string;
  feedId: string;
  scheduledAt: Date;
  configVersion: string;
  executorVersion: string;
  inputHash: string;
};
function scope(input: DiscoveryBinding) {
  return and(
    eq(discoveries.environment, input.environment),
    eq(discoveries.feedId, input.feedId),
    eq(discoveries.scheduledAt, input.scheduledAt),
  );
}
function assertBinding(row: typeof discoveries.$inferSelect, input: DiscoveryBinding) {
  if (
    row.jobId !== input.jobId ||
    row.configVersion !== input.configVersion ||
    row.executorVersion !== input.executorVersion ||
    row.inputHash !== input.inputHash ||
    !row.crawlJobId ||
    !row.feedJobId
  )
    throw new Error("DISCOVERY_SLOT_CONFLICT");
}
export class DiscoveryRepository {
  constructor(
    private readonly db: DbClient,
    private readonly cursorKey: Uint8Array,
  ) {}
  async authorize(input: DiscoveryBinding) {
    environmentSchema.parse(input.environment);
    referenceIdSchema.parse(input.jobId);
    const [existing] = await this.db.select().from(discoveries).where(scope(input));
    if (existing) assertBinding(existing, input);
  }
  async reserve(
    input: DiscoveryBinding & { sourceName: string; siteUrl: string; feedUrl: string },
  ) {
    await this.authorize(input);
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([input.environment, input.feedId, input.scheduledAt.toISOString()])},0))`,
      );
      const [existing] = await tx.select().from(discoveries).where(scope(input)).for("update");
      if (existing) {
        assertBinding(existing, input);
        return existing;
      }
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["job", input.environment, input.jobId])},0))`,
      );
      const jobRows = await tx
        .select()
        .from(discoveries)
        .where(
          and(eq(discoveries.environment, input.environment), eq(discoveries.jobId, input.jobId)),
        );
      if (
        jobRows.some(
          (row) =>
            row.configVersion !== input.configVersion ||
            row.executorVersion !== input.executorVersion ||
            !row.crawlJobId ||
            row.crawlJobId !== jobRows[0]?.crawlJobId,
        )
      )
        throw new Error("DISCOVERY_SLOT_CONFLICT");
      let crawlJobId = jobRows[0]?.crawlJobId;
      if (!crawlJobId) {
        const [job] = await tx.insert(crawlJobs).values({}).returning();
        if (!job) throw new Error("DISCOVERY_SAVE_FAILED");
        crawlJobId = job.id;
      }
      await tx
        .insert(sources)
        .values({ name: input.sourceName, siteUrl: input.siteUrl })
        .onConflictDoNothing();
      const [source] = await tx.select().from(sources).where(eq(sources.name, input.sourceName));
      if (!source || source.siteUrl !== input.siteUrl) throw new Error("DISCOVERY_CONFIG_CONFLICT");
      await tx
        .insert(feedEndpoints)
        .values({ sourceId: source.id, url: input.feedUrl })
        .onConflictDoNothing();
      const [endpoint] = await tx
        .select()
        .from(feedEndpoints)
        .where(eq(feedEndpoints.url, input.feedUrl));
      if (!endpoint || endpoint.sourceId !== source.id)
        throw new Error("DISCOVERY_CONFIG_CONFLICT");
      const [feedJob] = await tx
        .insert(crawlJobs)
        .values({ feedEndpointId: endpoint.id })
        .returning();
      if (!feedJob) throw new Error("DISCOVERY_SAVE_FAILED");
      const [saved] = await tx
        .insert(discoveries)
        .values({
          environment: input.environment,
          jobId: input.jobId,
          feedId: input.feedId,
          scheduledAt: input.scheduledAt,
          configVersion: input.configVersion,
          executorVersion: input.executorVersion,
          inputHash: input.inputHash,
          manifestHash: input.inputHash,
          crawlJobId,
          feedJobId: feedJob.id,
        })
        .returning();
      if (!saved) throw new Error("DISCOVERY_SAVE_FAILED");
      return saved;
    });
  }
  async save(
    fence: OperationFence,
    input: {
      binding: DiscoveryBinding;
      identity: OperationKeyInput;
      promptVersion: string;
      schemaVersion: string;
      items: DiscoveryCandidate[];
    },
  ) {
    const manifestId = randomUUID();
    const resultId = await new OperationRepository(this.db).complete(fence, async (tx) => {
      const [binding] = await tx
        .select()
        .from(discoveries)
        .where(scope(input.binding))
        .for("update");
      if (!binding) throw new Error("DISCOVERY_SLOT_CONFLICT");
      assertBinding(binding, input.binding);
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
        fence.environment !== binding.environment ||
        operation?.stage !== "discovery" ||
        operation.logicalEntityId !== input.identity.logicalEntityId ||
        operation.inputHash !== input.binding.inputHash
      )
        throw new Error("DISCOVERY_SLOT_CONFLICT");
      const [source] = await tx
        .select({ sourceId: feedEndpoints.sourceId })
        .from(crawlJobs)
        .innerJoin(feedEndpoints, eq(feedEndpoints.id, crawlJobs.feedEndpointId))
        .where(eq(crawlJobs.id, binding.feedJobId!));
      if (!source) throw new Error("DISCOVERY_SAVE_FAILED");
      const entries: {
        candidateId: string;
        disposition: "process" | "alreadyPublished" | "failed";
        errorCode?: string;
        generationId?: string;
        feedJobId: string;
      }[] = [];
      const items = prepareDiscoveryCandidates(
        input.items.map(({ normalizedUrl: _url, score: _score, ...value }) => value),
        100,
        binding.scheduledAt,
      ).sort((a, b) => a.normalizedUrl.localeCompare(b.normalizedUrl));
      for (const item of items) {
        await tx
          .insert(articles)
          .values({
            sourceId: source.sourceId,
            title: item.title,
            originalUrl: item.url,
            normalizedUrl: item.normalizedUrl,
            publishedAt: item.publishedAt,
          })
          .onConflictDoNothing();
        const [article] = await tx
          .select()
          .from(articles)
          .where(eq(articles.normalizedUrl, item.normalizedUrl))
          .for("update");
        if (!article) throw new Error("DISCOVERY_SAVE_FAILED");
        let joined: GenerationJoin | { status: "failed"; errorCode: string };
        try {
          joined = await new GenerationRepository(this.db).joinInTransaction(tx, {
            environment: binding.environment,
            articleId: article.id,
            configVersion: binding.configVersion,
            promptVersion: input.promptVersion,
            schemaVersion: input.schemaVersion,
          });
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "GENERATION_VERSION_CONFLICT")
            throw error;
          joined = { status: "failed", errorCode: "GENERATION_VERSION_CONFLICT" };
        }
        if (joined.status === "alreadyPublished")
          await tx
            .insert(articleMetrics)
            .values({
              articleId: article.id,
              bookmarks: item.bookmarks,
              views: item.views,
              score: item.score,
            })
            .onConflictDoUpdate({
              target: articleMetrics.articleId,
              set: {
                bookmarks: item.bookmarks,
                views: item.views,
                score: item.score,
                measuredAt: sql`clock_timestamp()`,
              },
            });
        const disposition =
          joined.status === "joined"
            ? ("process" as const)
            : joined.status === "failed"
              ? ("failed" as const)
              : ("alreadyPublished" as const);
        const [candidate] = await tx
          .insert(candidates)
          .values({
            discoveryId: binding.id,
            normalizedUrl: item.normalizedUrl,
            articleId: article.id,
            disposition,
            metadata: {
              title: item.title,
              summaryText: item.summaryText,
              contentHtml: item.contentHtml,
              sourceId: source.sourceId,
              feedJobId: binding.feedJobId,
              bookmarks: item.bookmarks,
              views: item.views,
              score: item.score,
              ...(joined.status === "joined" ? { generationId: joined.generationId } : {}),
              ...(joined.status === "failed" ? { errorCode: joined.errorCode } : {}),
            },
          })
          .returning();
        if (!candidate) throw new Error("DISCOVERY_SAVE_FAILED");
        entries.push({
          candidateId: candidate.id,
          disposition,
          feedJobId: binding.feedJobId!,
          ...(joined.status === "joined" ? { generationId: joined.generationId } : {}),
          ...(joined.status === "failed" ? { errorCode: joined.errorCode } : {}),
        });
      }
      await new ManifestRepository(this.db, this.cursorKey).createInTransaction(tx, {
        id: manifestId,
        environment: binding.environment,
        kind: "candidates",
        discoveryId: binding.id,
        entries,
      });
      await tx
        .update(discoveries)
        .set({ manifestHash: createHash("sha256").update(JSON.stringify(entries)).digest("hex") })
        .where(eq(discoveries.id, binding.id));
      await tx
        .update(crawlJobs)
        .set({ fetchedCount: entries.length })
        .where(eq(crawlJobs.id, binding.feedJobId!));
      return {
        output: {
          kind: "stage",
          response: {
            status: "succeeded",
            stage: "discovery",
            discoveryId: binding.id,
            manifestId,
            candidateCount: entries.length,
          },
        },
        effectiveModel: "",
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    });
    const result = await new ResultRepository(this.db).read(fence.environment, resultId);
    if (result?.output.kind !== "stage" || result.output.response.stage !== "discovery")
      throw new Error("DISCOVERY_SAVE_FAILED");
    return result.output.response;
  }
}
