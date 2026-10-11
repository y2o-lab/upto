import { environmentSchema, referenceIdSchema, type BatchEnvironment } from "@upto/domain/batch";
import { and, eq, sql } from "drizzle-orm";

import type { DbClient } from "../client.js";
import type { DbTransaction } from "./database-types.js";

import { articles } from "../schema.js";
import { collectorGenerations as generations } from "./schema.js";

export type JoinGenerationInput = {
  environment: BatchEnvironment;
  articleId: string;
  configVersion: string;
  promptVersion: string;
  schemaVersion: string;
};
export type GenerationJoin =
  | { status: "joined"; generationId: string; articleId: string }
  | { status: "alreadyPublished"; articleId: string };
export class GenerationRepository {
  constructor(private readonly db: DbClient) {}
  async join(input: JoinGenerationInput): Promise<GenerationJoin> {
    return this.db.transaction((tx) => this.joinInTransaction(tx, input));
  }
  async joinInTransaction(tx: DbTransaction, input: JoinGenerationInput): Promise<GenerationJoin> {
    environmentSchema.parse(input.environment);
    referenceIdSchema.parse(input.articleId);
    for (const version of [input.configVersion, input.promptVersion, input.schemaVersion])
      if (!version || version.length > 128) throw new Error("INVALID_GENERATION_VERSION");
    const [article] = await tx
      .select()
      .from(articles)
      .where(eq(articles.id, input.articleId))
      .for("update");
    if (!article) throw new Error("ARTICLE_NOT_FOUND");
    if (article.summaryStatus === "summarized")
      return { status: "alreadyPublished", articleId: article.id };
    const [active] = await tx
      .select()
      .from(generations)
      .where(
        and(
          eq(generations.articleId, input.articleId),
          sql`${generations.status} IN ('pending', 'running', 'waiting', 'uncertain')`,
        ),
      );
    if (active) {
      if (
        active.environment !== input.environment ||
        active.configVersion !== input.configVersion ||
        active.promptVersion !== input.promptVersion ||
        active.schemaVersion !== input.schemaVersion
      )
        throw new Error("GENERATION_VERSION_CONFLICT");
      return { status: "joined", articleId: article.id, generationId: active.id };
    }
    const [created] = await tx.insert(generations).values(input).returning();
    if (!created) throw new Error("GENERATION_CREATE_FAILED");
    return { status: "joined", articleId: article.id, generationId: created.id };
  }
}
