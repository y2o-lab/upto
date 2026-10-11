import { operationKey } from "@upto/domain/batch";
import { sql } from "drizzle-orm";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";

import { createDb, closeDb } from "../src/client.js";
import { GenerationRepository, OperationRepository } from "../src/collector/index.js";
import { createIntegrationDatabase } from "./database.js";

let context: Awaited<ReturnType<typeof createIntegrationDatabase>>;
let articleId: string;
let generationId: string;
let repo: OperationRepository;
async function claim(entity: string, owner: string, repository = repo) {
  const identity = {
    environment: "staging" as const,
    stage: "summarize-chunk" as const,
    logicalEntityId: generationId + "/" + entity,
    inputHash: "a".repeat(64),
    model: "fixture-model",
    promptVersion: "1",
    schemaVersion: "1",
  };
  return repository.claim({
    ...identity,
    generationId,
    operationKey: await operationKey(identity),
    owner,
    leaseMs: 360000,
  });
}
beforeAll(async () => {
  context = await createIntegrationDatabase();
  repo = new OperationRepository(context.db);
  const source = await context.pool.query(
    "INSERT INTO sources(name,site_url) VALUES ('fixture','https://fixture.example') RETURNING id",
  );
  const article = await context.pool.query(
    "INSERT INTO articles(source_id,title,original_url,normalized_url) VALUES ($1,'架空記事','https://fixture.example/lease','https://fixture.example/lease') RETURNING id",
    [source.rows[0].id],
  );
  articleId = article.rows[0].id;
});
afterEach(async () => {
  await context.pool.query(
    "TRUNCATE collector_operations, collector_results, collector_api_attempts, collector_generations CASCADE",
  );
});
afterAll(async () => {
  await context?.close();
});
async function join() {
  const value = await new GenerationRepository(context.db).join({
    environment: "staging",
    articleId,
    configVersion: "1",
    promptVersion: "1",
    schemaVersion: "1",
  });
  if (value.status !== "joined") throw new Error("Expected join");
  generationId = value.generationId;
}
describe("generation ownership across operation stages", () => {
  it("allows only one active operation per generation across separate pools", async () => {
    await join();
    const other = createDb(context.url);
    try {
      const results = await Promise.all([
        claim("one", "owner-one"),
        claim("two", "owner-two", new OperationRepository(other)),
      ]);
      expect(results.map((result) => result.status).sort()).toEqual(["claimed", "running"]);
      expect(
        (await context.pool.query("SELECT count(*)::int AS count FROM collector_operations"))
          .rows[0].count,
      ).toBe(1);
      const generation = (
        await context.pool.query("SELECT status,lease_epoch FROM collector_generations")
      ).rows[0];
      expect(generation.status).toBe("running");
      expect(generation.lease_epoch).toBe("1");
    } finally {
      await closeDb(other);
    }
  });
  it("releases generation ownership on quota wait without increasing API attempts", async () => {
    await join();
    const first = await claim("one", "owner-one");
    if (first.status !== "claimed") throw new Error("Expected claim");
    await repo.wait(first.fence, new Date(Date.now() + 60000), "QUOTA_WAIT");
    const second = await claim("two", "owner-two");
    expect(second.status).toBe("claimed");
    const row = (
      await context.pool.query("SELECT lease_epoch,lease_owner FROM collector_generations")
    ).rows[0];
    expect(row.lease_epoch).toBe("2");
    expect(row.lease_owner).toBe("owner-two");
    expect(
      (await context.pool.query("SELECT sum(api_attempt)::int AS count FROM collector_operations"))
        .rows[0].count,
    ).toBe(0);
  });
  it("rejects sending when generation epoch changes even while operation epoch is unchanged", async () => {
    await join();
    const first = await claim("one", "owner-one");
    if (first.status !== "claimed") throw new Error("Expected claim");
    await context.pool.query("UPDATE collector_generations SET lease_epoch=lease_epoch+1");
    await expect(
      repo.markSent(first.fence, {
        attempt: 1,
        permitId: crypto.randomUUID(),
        reservedTokens: 10,
        countVersion: "1",
        quotaVersion: "1",
      }),
    ).rejects.toThrow("STALE_GENERATION_OWNER");
    expect(
      (await context.pool.query("SELECT count(*)::int AS count FROM collector_api_attempts"))
        .rows[0].count,
    ).toBe(0);
  });
  it("reclaims expired unsent ownership but refuses old owner's completion", async () => {
    await join();
    const first = await claim("one", "old");
    if (first.status !== "claimed") throw new Error("Expected claim");
    await context.pool.query(
      "UPDATE collector_generations SET lease_until=clock_timestamp()-interval '1 second'",
    );
    await context.pool.query(
      "UPDATE collector_operations SET lease_until=clock_timestamp()-interval '1 second'",
    );
    const second = await claim("two", "new");
    expect(second.status).toBe("claimed");
    expect(
      (await context.pool.query("SELECT lease_epoch FROM collector_generations")).rows[0]
        .lease_epoch,
    ).toBe("2");
    await expect(repo.fail(first.fence, "LATE_FAILURE")).rejects.toThrow("STALE_OPERATION_OWNER");
  });
  it("blocks every new model/stage operation after any unresolved generation send", async () => {
    await join();
    const first = await claim("one", "old");
    if (first.status !== "claimed") throw new Error("Expected claim");
    await repo.markSent(first.fence, {
      attempt: 1,
      permitId: crypto.randomUUID(),
      reservedTokens: 10,
      countVersion: "1",
      quotaVersion: "1",
    });
    await context.pool.query(
      "UPDATE collector_generations SET lease_until=clock_timestamp()-interval '1 second'",
    );
    await context.pool.query(
      "UPDATE collector_operations SET lease_until=clock_timestamp()-interval '1 second'",
    );
    expect((await claim("other-operation", "new")).status).toBe("uncertain");
    expect(
      (await context.pool.query("SELECT status FROM collector_generations")).rows[0].status,
    ).toBe("uncertain");
    expect(await repo.status("staging", first.fence.operationKey)).toEqual({ status: "uncertain" });
    expect(
      (await context.pool.query("SELECT count(*)::int AS count FROM collector_api_attempts"))
        .rows[0].count,
    ).toBe(1);
  });
  it("rolls back result, usage and completion when generation fencing fails at the final write", async () => {
    await join();
    const first = await claim("one", "owner-one");
    if (first.status !== "claimed") throw new Error("Expected claim");
    await repo.markSent(first.fence, {
      attempt: 1,
      permitId: crypto.randomUUID(),
      reservedTokens: 10,
      countVersion: "1",
      quotaVersion: "1",
    });
    await expect(
      repo.complete(
        first.fence,
        {
          output: { kind: "chunk", text: "架空要約" },
          effectiveModel: "fixture-model",
          usage: { inputTokens: 10, outputTokens: 5 },
        },
        async (tx) => {
          await tx.execute(sql`UPDATE collector_generations SET lease_epoch=lease_epoch+1`);
        },
      ),
    ).rejects.toThrow("STALE_GENERATION_OWNER");
    expect(
      (await context.pool.query("SELECT count(*)::int AS count FROM collector_results")).rows[0]
        .count,
    ).toBe(0);
    expect(
      (await context.pool.query("SELECT status FROM collector_api_attempts")).rows[0].status,
    ).toBe("sent");
    expect(
      (await context.pool.query("SELECT lease_epoch FROM collector_generations")).rows[0]
        .lease_epoch,
    ).toBe("1");
  });
  it("does not finish a generation on an empty persist callback without the published article graph", async () => {
    await join();
    const identity = {
      environment: "staging" as const,
      stage: "persist" as const,
      logicalEntityId: generationId,
      inputHash: "a".repeat(64),
      model: "",
      promptVersion: "1",
      schemaVersion: "1",
    };
    const value = await repo.claim({
      ...identity,
      generationId,
      operationKey: await operationKey(identity),
      owner: "publisher",
      leaseMs: 360000,
    });
    if (value.status !== "claimed") throw new Error("Expected claim");
    await expect(
      repo.complete(
        value.fence,
        {
          output: {
            kind: "stage",
            response: {
              status: "succeeded",
              stage: "persist",
              articleId,
              publication: "published",
            },
          },
          effectiveModel: "",
          usage: { inputTokens: 0, outputTokens: 0 },
        },
        async () => {},
      ),
    ).rejects.toThrow("GENERATION_PUBLICATION_REQUIRED");
    expect(
      (await context.pool.query("SELECT status FROM collector_generations")).rows[0].status,
    ).toBe("running");
    expect(
      (await context.pool.query("SELECT count(*)::int AS count FROM collector_results")).rows[0]
        .count,
    ).toBe(0);
  });
  it("preserves successful result replay after the generation lease moves to a new stage", async () => {
    await join();
    const first = await claim("one", "owner-one");
    if (first.status !== "claimed") throw new Error("Expected claim");
    await repo.markSent(first.fence, {
      attempt: 1,
      permitId: crypto.randomUUID(),
      reservedTokens: 10,
      countVersion: "1",
      quotaVersion: "1",
    });
    const resultId = await repo.complete(first.fence, {
      output: { kind: "chunk", text: "架空要約" },
      effectiveModel: "fixture-model",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    expect((await claim("two", "owner-two")).status).toBe("claimed");
    expect(await repo.status("staging", first.fence.operationKey)).toEqual({
      status: "succeeded",
      resultId,
    });
    expect((await claim("one", "retry")).status).toBe("succeeded");
  });
});
