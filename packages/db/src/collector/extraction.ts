import { normalizeArticleUrl } from "@upto/domain";
import {
  candidateExtractionMetadataSchema,
  extractionInputSchema,
  environmentSchema,
  referenceIdSchema,
  type BatchEnvironment,
} from "@upto/domain/batch";
import { and, eq } from "drizzle-orm";
import { createHash } from "node:crypto";

import type { DbClient } from "../client.js";

import { articles } from "../schema-core.js";
import {
  collectorCandidates as candidates,
  collectorDiscoveries as discoveries,
  collectorGenerations as generations,
  collectorExtractionInputs as inputs,
} from "./schema.js";

export class ExtractionRepository {
  constructor(private readonly db: DbClient) {}
  async describe(reference: {
    environment: BatchEnvironment;
    generationId: string;
    candidateId: string;
    jobId: string;
    configVersion: string;
    executorVersion: string;
    chunkChars: number;
    chunkerVersion: string;
  }) {
    environmentSchema.parse(reference.environment);
    for (const id of [reference.generationId, reference.candidateId, reference.jobId])
      referenceIdSchema.parse(id);
    return this.db.transaction(async (tx) => {
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
      const [candidate] = await tx
        .select({ candidate: candidates, discovery: discoveries, article: articles })
        .from(candidates)
        .innerJoin(discoveries, eq(discoveries.id, candidates.discoveryId))
        .innerJoin(articles, eq(articles.id, candidates.articleId))
        .where(eq(candidates.id, reference.candidateId));
      if (
        !generation ||
        !candidate ||
        candidate.candidate.articleId !== generation.articleId ||
        candidate.candidate.disposition !== "process" ||
        (candidate.candidate.metadata.generationId !== undefined &&
          candidate.candidate.metadata.generationId !== generation.id) ||
        candidate.discovery.environment !== reference.environment ||
        candidate.discovery.jobId !== reference.jobId ||
        candidate.discovery.configVersion !== reference.configVersion ||
        candidate.discovery.executorVersion !== reference.executorVersion ||
        generation.configVersion !== reference.configVersion ||
        candidate.candidate.normalizedUrl !== candidate.article.normalizedUrl ||
        normalizeArticleUrl(candidate.candidate.normalizedUrl) !== candidate.candidate.normalizedUrl
      )
        throw new Error("EXTRACTION_REFERENCE_MISMATCH");
      let [snapshot] = await tx.select().from(inputs).where(eq(inputs.generationId, generation.id));
      if (!snapshot) {
        if (!["pending", "running", "waiting"].includes(generation.status))
          throw new Error("GENERATION_TERMINAL");
        const metadata = candidateExtractionMetadataSchema.parse(candidate.candidate.metadata);
        const input = extractionInputSchema.parse({
          url: candidate.candidate.normalizedUrl,
          fallbackText: metadata.summaryText,
          fallbackHtml: metadata.contentHtml,
          chunkChars: reference.chunkChars,
          chunkerVersion: reference.chunkerVersion,
        });
        [snapshot] = await tx
          .insert(inputs)
          .values({
            generationId: generation.id,
            candidateId: candidate.candidate.id,
            input,
            inputHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
          })
          .returning();
      }
      if (!snapshot) throw new Error("EXTRACTION_REFERENCE_MISMATCH");
      const input = extractionInputSchema.parse(snapshot.input);
      if (snapshot.inputHash !== createHash("sha256").update(JSON.stringify(input)).digest("hex"))
        throw new Error("EXTRACTION_INPUT_INTEGRITY_MISMATCH");
      if (
        input.chunkChars !== reference.chunkChars ||
        input.chunkerVersion !== reference.chunkerVersion
      )
        throw new Error("GENERATION_VERSION_CONFLICT");
      return {
        input,
        identity: {
          environment: reference.environment,
          stage: "extract" as const,
          logicalEntityId: generation.id,
          inputHash: snapshot.inputHash,
          model: "",
          promptVersion: generation.promptVersion,
          schemaVersion: generation.schemaVersion,
        },
        generationId: generation.id,
      };
    });
  }
}
