import { operationKey } from "@upto/domain/batch";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";

import { closeDb, createDb } from "../src/client.js";
import { GenerationRepository } from "../src/collector/generations.js";
import { ManifestRepository } from "../src/collector/manifests.js";
import { OperationRepository } from "../src/collector/operations.js";
import { PayloadRepository } from "../src/collector/payloads.js";
import { ResultRepository } from "../src/collector/results.js";
import { createIntegrationDatabase } from "./database.js";

let context: Awaited<ReturnType<typeof createIntegrationDatabase>>;
let generationId: string;
let payloads: PayloadRepository;
let manifests: ManifestRepository;
const key = new TextEncoder().encode("fixture-cursor-key-material-not-real-0001");
const snapshot = () => ({
  generationId,
  contentText: "架空本文",
  contentHtml: "<p>架空本文</p>",
  extractionStatus: "extracted" as const,
  chunkerVersion: "1",
  chunks: ["架空", "本文"],
});
async function extractionClaim(owner = "fixture", inputHash = "a".repeat(64)) {
  const identity = {
    environment: "staging" as const,
    stage: "extract" as const,
    logicalEntityId: generationId,
    inputHash,
    model: "",
    promptVersion: "1",
    schemaVersion: "1",
  };
  const claim = await new OperationRepository(context.db).claim({
    ...identity,
    operationKey: await operationKey(identity),
    generationId,
    owner,
    leaseMs: 360000,
  });
  if (claim.status !== "claimed") throw new Error("Expected claim");
  return claim;
}
beforeAll(async () => {
  context = await createIntegrationDatabase();
  payloads = new PayloadRepository(context.db, key);
  manifests = new ManifestRepository(context.db, key);
  const source = await context.pool.query(
    "INSERT INTO sources(name,site_url) VALUES ('fixture','https://fixture.example') RETURNING id",
  );
  const article = await context.pool.query(
    "INSERT INTO articles(source_id,title,original_url,normalized_url) VALUES ($1,'架空記事','https://fixture.example/a','https://fixture.example/a') RETURNING id",
    [source.rows[0].id],
  );
  const join = await new GenerationRepository(context.db).join({
    articleId: article.rows[0].id,
    environment: "staging",
    configVersion: "1",
    promptVersion: "1",
    schemaVersion: "1",
  });
  if (join.status !== "joined") throw new Error("Expected generation");
  generationId = join.generationId;
});
afterEach(async () => {
  await context.pool.query("DROP TRIGGER IF EXISTS fail_snapshot ON collector_chunks");
  await context.pool.query(
    "TRUNCATE collector_payloads, collector_chunks, collector_operations, collector_results, collector_api_attempts, collector_manifests, collector_manifest_entries CASCADE",
  );
  await context.pool.query("UPDATE collector_generations SET input_hash=NULL, status='pending'");
});
afterAll(async () => {
  await context?.close();
});
async function counts() {
  const result = await context.pool.query(
    "SELECT (SELECT count(*)::int FROM collector_payloads) AS payloads,(SELECT count(*)::int FROM collector_chunks) AS chunks,(SELECT count(*)::int FROM collector_manifests) AS manifests,(SELECT count(*)::int FROM collector_results) AS results",
  );
  return result.rows[0];
}
describe("extraction snapshot transactions", () => {
  it("stores payload/chunks/manifest/result and operation success atomically", async () => {
    const claim = await extractionClaim();
    const result = await payloads.saveExtraction(claim.fence, snapshot());
    expect(await counts()).toEqual({ payloads: 1, chunks: 2, manifests: 1, results: 1 });
    expect(result.chunkCount).toBe(2);
    const page = await manifests.page({
      apiVersion: "v1",
      environment: "staging",
      manifestId: result.chunkManifestId,
      limit: 50,
    });
    expect(page.entries).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
    expect(
      await new OperationRepository(context.db).status("staging", claim.fence.operationKey),
    ).toMatchObject({ status: "succeeded" });
    const loaded = await payloads.extraction("staging", generationId);
    expect(loaded?.contentText).toBe("架空本文");
    expect(await payloads.extraction("production", generationId)).toBeNull();
  });
  it("loads committed results only for their environment and generation and checks integrity", async () => {
    const claim = await extractionClaim();
    await payloads.saveExtraction(claim.fence, snapshot());
    const status = await new OperationRepository(context.db).status(
      "staging",
      claim.fence.operationKey,
    );
    if (status.status !== "succeeded") throw new Error("Expected result");
    const repo = new ResultRepository(context.db);
    const saved = await repo.read("staging", status.resultId, generationId);
    expect(saved?.output).toMatchObject({
      kind: "stage",
      response: { stage: "extract", chunkCount: 2 },
    });
    expect(await repo.read("production", status.resultId, generationId)).toBeNull();
    expect(await repo.read("staging", status.resultId, crypto.randomUUID())).toBeNull();
    await context.pool.query("UPDATE collector_results SET output_hash=$1 WHERE id=$2", [
      "b".repeat(64),
      status.resultId,
    ]);
    await expect(repo.read("staging", status.resultId, generationId)).rejects.toThrow(
      "RESULT_INTEGRITY_MISMATCH",
    );
  });
  it("refuses extraction after a terminal generation or with another generation reference", async () => {
    const claim = await extractionClaim();
    await context.pool.query("UPDATE collector_generations SET status='failed'");
    await expect(payloads.saveExtraction(claim.fence, snapshot())).rejects.toThrow(
      "STALE_GENERATION_OWNER",
    );
    await context.pool.query("UPDATE collector_generations SET status='running'");
    await expect(
      payloads.saveExtraction(claim.fence, { ...snapshot(), generationId: crypto.randomUUID() }),
    ).rejects.toThrow("GENERATION_REFERENCE_MISMATCH");
    expect(await counts()).toEqual({ payloads: 0, chunks: 0, manifests: 0, results: 0 });
  });
  it("rolls all snapshot writes back if a chunk save fails", async () => {
    const claim = await extractionClaim();
    await context.pool.query(
      "CREATE FUNCTION fail_snapshot_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_failure'; END $$",
    );
    await context.pool.query(
      "CREATE TRIGGER fail_snapshot BEFORE INSERT ON collector_chunks FOR EACH ROW EXECUTE FUNCTION fail_snapshot_write()",
    );
    await expect(payloads.saveExtraction(claim.fence, snapshot())).rejects.toThrow();
    expect(await counts()).toEqual({ payloads: 0, chunks: 0, manifests: 0, results: 0 });
    expect(
      (await new OperationRepository(context.db).status("staging", claim.fence.operationKey))
        .status,
    ).toBe("running");
  });
  it("rejects stale owner and invalid chunk coverage before publication", async () => {
    const claim = await extractionClaim();
    await expect(
      payloads.saveExtraction({ ...claim.fence, leaseEpoch: 2 }, snapshot()),
    ).rejects.toThrow("STALE_OPERATION_OWNER");
    await expect(
      payloads.saveExtraction(claim.fence, { ...snapshot(), chunks: ["欠落"] }),
    ).rejects.toThrow();
    expect(await counts()).toEqual({ payloads: 0, chunks: 0, manifests: 0, results: 0 });
  });
  it("never overwrites a generation's immutable extraction", async () => {
    await payloads.saveExtraction((await extractionClaim()).fence, snapshot());
    const another = await extractionClaim("another", "b".repeat(64));
    await expect(
      payloads.saveExtraction(another.fence, {
        ...snapshot(),
        contentText: "変更",
        chunks: ["変更"],
      }),
    ).rejects.toThrow("EXTRACTION_SNAPSHOT_CONFLICT");
    expect(await counts()).toEqual({ payloads: 1, chunks: 2, manifests: 1, results: 1 });
    expect((await payloads.extraction("staging", generationId))?.contentText).toBe("架空本文");
  });
});

describe("immutable manifest pagination", () => {
  async function create(size: number) {
    const id = crypto.randomUUID();
    const entries = [];
    for (let index = 0; index < size; index++) {
      const row = await context.pool.query(
        'INSERT INTO collector_chunks(generation_id,"index",payload,input_hash) VALUES ($1,$2,$3,$4) ON CONFLICT(generation_id,"index") DO UPDATE SET input_hash=excluded.input_hash RETURNING id',
        [generationId, index, "架空chunk", "a".repeat(64)],
      );
      entries.push({ chunkId: row.rows[0].id as string, index, inputHash: "a".repeat(64) });
    }
    await manifests.create({ id, environment: "staging", kind: "chunks", generationId, entries });
    return { id, entries };
  }
  it("paginates without omissions/duplicates and handles empty and final pages", async () => {
    const { id, entries } = await create(64);
    const first = await manifests.page({
      apiVersion: "v1",
      environment: "staging",
      manifestId: id,
      limit: 50,
    });
    const second = await manifests.page({
      apiVersion: "v1",
      environment: "staging",
      manifestId: id,
      limit: 50,
      cursor: first.nextCursor!,
    });
    expect([...first.entries, ...second.entries]).toEqual(entries);
    expect(second.nextCursor).toBeNull();
    const empty = await create(0);
    expect(
      (
        await manifests.page({
          apiVersion: "v1",
          environment: "staging",
          manifestId: empty.id,
          limit: 50,
        })
      ).entries,
    ).toEqual([]);
  });
  it("binds cursors to environment and manifest and rejects tampering", async () => {
    const first = await create(2);
    const other = await create(1);
    const page = await manifests.page({
      apiVersion: "v1",
      environment: "staging",
      manifestId: first.id,
      limit: 1,
    });
    await expect(
      manifests.page({
        apiVersion: "v1",
        environment: "staging",
        manifestId: other.id,
        limit: 1,
        cursor: page.nextCursor!,
      }),
    ).rejects.toThrow("MANIFEST_CURSOR_INVALID");
    await expect(
      manifests.page({
        apiVersion: "v1",
        environment: "production",
        manifestId: first.id,
        limit: 1,
      }),
    ).rejects.toThrow("MANIFEST_NOT_FOUND");
    await expect(
      manifests.page({
        apiVersion: "v1",
        environment: "staging",
        manifestId: first.id,
        limit: 1,
        cursor: page.nextCursor! + "x",
      }),
    ).rejects.toThrow("MANIFEST_CURSOR_INVALID");
  });
  it("keeps one snapshot when two independent PG clients register it concurrently", async () => {
    const seed = await create(2);
    const id = crypto.randomUUID();
    const input = {
      id,
      environment: "staging" as const,
      kind: "chunks" as const,
      generationId,
      entries: seed.entries,
    };
    const other = createDb(context.url);
    try {
      await Promise.all([
        manifests.create(input),
        new ManifestRepository(other, key).create(input),
      ]);
      expect(
        (
          await context.pool.query(
            "SELECT count(*)::int AS count FROM collector_manifest_entries WHERE manifest_id=$1",
            [id],
          )
        ).rows[0].count,
      ).toBe(2);
    } finally {
      await closeDb(other);
    }
  });
  it("refuses unknown/cross-generation references instead of storing arbitrary identifiers", async () => {
    await expect(
      manifests.create({
        id: crypto.randomUUID(),
        environment: "staging",
        kind: "chunks",
        generationId,
        entries: [{ chunkId: crypto.randomUUID(), index: 0, inputHash: "a".repeat(64) }],
      }),
    ).rejects.toThrow("MANIFEST_REFERENCE_MISMATCH");
    const seed = await create(1);
    await expect(
      manifests.create({
        id: crypto.randomUUID(),
        environment: "staging",
        kind: "chunks",
        generationId: crypto.randomUUID(),
        entries: seed.entries,
      }),
    ).rejects.toThrow("MANIFEST_REFERENCE_MISMATCH");
  });
  it("handles candidate and result manifests with owned references", async () => {
    const discovery = await context.pool.query(
      "INSERT INTO collector_discoveries(environment,job_id,feed_id,scheduled_at,executor_version,config_version,manifest_hash) VALUES ('staging',$1,$2,clock_timestamp(),'fixture','1',$3) RETURNING id",
      [crypto.randomUUID(), crypto.randomUUID(), "a".repeat(64)],
    );
    const discoveryId = discovery.rows[0].id as string;
    const candidate = await context.pool.query(
      "INSERT INTO collector_candidates(discovery_id,normalized_url,metadata,disposition) VALUES ($1,'https://fixture.example/a','{}','process') RETURNING id",
      [discoveryId],
    );
    const candidateId = candidate.rows[0].id as string;
    const candidateManifest = crypto.randomUUID();
    await manifests.create({
      id: candidateManifest,
      environment: "staging",
      kind: "candidates",
      discoveryId,
      entries: [{ candidateId, disposition: "process" }],
    });
    expect(
      (
        await manifests.page({
          apiVersion: "v1",
          environment: "staging",
          manifestId: candidateManifest,
          limit: 50,
        })
      ).entries,
    ).toEqual([{ candidateId, disposition: "process" }]);
    await expect(
      manifests.create({
        id: crypto.randomUUID(),
        environment: "production",
        kind: "candidates",
        discoveryId,
        entries: [{ candidateId, disposition: "process" }],
      }),
    ).rejects.toThrow("MANIFEST_REFERENCE_MISMATCH");
    await expect(
      manifests.create({
        id: crypto.randomUUID(),
        environment: "staging",
        kind: "candidates",
        discoveryId,
        entries: [
          { candidateId, disposition: "process" },
          { candidateId, disposition: "process" },
        ],
      }),
    ).rejects.toThrow("MANIFEST_DUPLICATE_ENTRY");
    const identity = {
      environment: "staging" as const,
      stage: "summarize-chunk" as const,
      logicalEntityId: generationId + "/fixture",
      inputHash: "a".repeat(64),
      model: "fixture-model",
      promptVersion: "1",
      schemaVersion: "1",
    };
    const repo = new OperationRepository(context.db);
    const claim = await repo.claim({
      ...identity,
      operationKey: await operationKey(identity),
      generationId,
      owner: "fixture",
      leaseMs: 360000,
    });
    if (claim.status !== "claimed") throw new Error("Expected claim");
    await repo.markSent(claim.fence, {
      attempt: 1,
      permitId: crypto.randomUUID(),
      reservedTokens: 10,
      countVersion: "1",
      quotaVersion: "1",
    });
    const resultId = await repo.complete(claim.fence, {
      output: { kind: "chunk", text: "架空要約" },
      effectiveModel: "fixture-model",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
    const result = await new ResultRepository(context.db).read("staging", resultId, generationId);
    if (!result) throw new Error("Expected result");
    const resultManifest = crypto.randomUUID();
    await manifests.create({
      id: resultManifest,
      environment: "staging",
      kind: "results",
      generationId,
      entries: [{ resultId, index: 0, inputHash: result.outputHash }],
    });
    expect(
      (
        await manifests.page({
          apiVersion: "v1",
          environment: "staging",
          manifestId: resultManifest,
          limit: 50,
        })
      ).entries,
    ).toEqual([{ resultId, index: 0, inputHash: result.outputHash }]);
  });
  it("allows identical snapshot registration but rejects changed entries", async () => {
    const value = await create(2);
    await manifests.create({
      id: value.id,
      environment: "staging",
      kind: "chunks",
      generationId,
      entries: value.entries,
    });
    await expect(
      manifests.create({
        id: value.id,
        environment: "staging",
        kind: "chunks",
        generationId,
        entries: [...value.entries].reverse(),
      }),
    ).rejects.toThrow();
    const changed = value.entries.map((entry) => ({ ...entry, inputHash: "b".repeat(64) }));
    await expect(
      manifests.create({
        id: value.id,
        environment: "staging",
        kind: "chunks",
        generationId,
        entries: changed,
      }),
    ).rejects.toThrow("MANIFEST_SNAPSHOT_CONFLICT");
  });
});
