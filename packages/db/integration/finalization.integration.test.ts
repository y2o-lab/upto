import { operationKey } from "@upto/domain/batch";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";

import { createDb, closeDb } from "../src/client.js";
import { FinalizationRepository } from "../src/collector/finalization.js";
import { OperationRepository } from "../src/collector/operations.js";
import { createIntegrationDatabase } from "./database.js";

let context: Awaited<ReturnType<typeof createIntegrationDatabase>>;
let jobId: string;
let crawlJobId: string;
let endpointId: string;
const counts = { fetched: 3, succeeded: 2, failed: 1, cancelled: 0 };
async function initialize() {
  jobId = crypto.randomUUID();
  const job = await context.pool.query(
    "INSERT INTO crawl_jobs(feed_endpoint_id) VALUES ($1) RETURNING id",
    [endpointId],
  );
  crawlJobId = job.rows[0].id;
  await context.pool.query(
    "INSERT INTO collector_discoveries(environment,job_id,feed_id,scheduled_at,executor_version,config_version,manifest_hash,crawl_job_id) VALUES ('staging',$1,$2,clock_timestamp(),'fixture','1',$3,$4)",
    [jobId, crypto.randomUUID(), "a".repeat(64), crawlJobId],
  );
}
async function finalize(version = 1, values = counts, db = context.db) {
  const repo = new FinalizationRepository(db);
  const input = {
    environment: "staging" as const,
    jobId,
    countVersion: version,
    counts: values,
    errorCode: null,
  };
  const resolved = await repo.describe(input);
  const claim = await new OperationRepository(db).claim({
    ...resolved.identity,
    operationKey: await operationKey(resolved.identity),
    owner: crypto.randomUUID(),
    leaseMs: 360000,
  });
  if (claim.status !== "claimed") return claim;
  return repo.finalize(claim.fence, input);
}
beforeAll(async () => {
  context = await createIntegrationDatabase();
  const source = await context.pool.query(
    "INSERT INTO sources(name,site_url) VALUES ('fixture','https://fixture.example') RETURNING id",
  );
  const endpoint = await context.pool.query(
    "INSERT INTO feed_endpoints(source_id,url) VALUES ($1,'https://fixture.example/feed') RETURNING id",
    [source.rows[0].id],
  );
  endpointId = endpoint.rows[0].id;
});
afterEach(async () => {
  await context.pool.query("DROP TRIGGER IF EXISTS fail_finalize ON crawl_jobs");
  await context.pool.query(
    "TRUNCATE collector_discoveries,collector_job_projections,collector_operations,collector_results,crawl_jobs CASCADE",
  );
});
afterAll(async () => {
  await context?.close();
});
describe("job projection transactions", () => {
  it("projects counts once into the existing legacy enum", async () => {
    await initialize();
    const result = await finalize();
    expect(result).toMatchObject({ stage: "job-finalize", crawlJobId, countVersion: 1 });
    expect(
      (await context.pool.query("SELECT status,fetched_count,failed_count FROM crawl_jobs"))
        .rows[0],
    ).toEqual({ status: "failed", fetched_count: 3, failed_count: 1 });
    expect((await finalize()).status).toBe("succeeded");
    expect(
      (await context.pool.query("SELECT count(*)::int AS count FROM collector_job_projections"))
        .rows[0].count,
    ).toBe(1);
  });
  it("rejects same-version conflicting counts and stale versions", async () => {
    await initialize();
    await finalize(2);
    await expect(finalize(2, { ...counts, succeeded: 1, failed: 2 })).rejects.toThrow(
      "COUNT_VERSION_CONFLICT",
    );
    await expect(finalize(1)).rejects.toThrow("COUNT_VERSION_CONFLICT");
    expect(
      (await context.pool.query("SELECT count_version FROM collector_job_projections")).rows[0]
        .count_version,
    ).toBe(2);
  });
  it("serializes concurrent distinct claims without double aggregation", async () => {
    await initialize();
    const other = createDb(context.url);
    try {
      const results = await Promise.all(
        [finalize(1, counts), finalize(1, { ...counts, succeeded: 1, failed: 2 }, other)].map(
          (value) =>
            value.then(
              (result) => ({ ok: true, result }),
              (error) => ({ ok: false, error }),
            ),
        ),
      );
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(
        (await context.pool.query("SELECT count(*)::int AS count FROM collector_job_projections"))
          .rows[0].count,
      ).toBe(1);
    } finally {
      await closeDb(other);
    }
  });
  it("rolls back the projection/result when the legacy update fails", async () => {
    await initialize();
    await context.pool.query(
      "CREATE FUNCTION fail_finalize_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_failure'; END $$",
    );
    await context.pool.query(
      "CREATE TRIGGER fail_finalize BEFORE UPDATE ON crawl_jobs FOR EACH ROW EXECUTE FUNCTION fail_finalize_write()",
    );
    await expect(finalize()).rejects.toThrow();
    expect(
      (await context.pool.query("SELECT count(*)::int AS count FROM collector_job_projections"))
        .rows[0].count,
    ).toBe(0);
    expect(
      (await context.pool.query("SELECT count(*)::int AS count FROM collector_results")).rows[0]
        .count,
    ).toBe(0);
    expect((await context.pool.query("SELECT status FROM crawl_jobs")).rows[0].status).toBe(
      "running",
    );
  });
  it("rejects reference/environment confusion and success regression", async () => {
    await initialize();
    const repo = new FinalizationRepository(context.db);
    await expect(
      repo.describe({ environment: "production", jobId, countVersion: 1, counts, errorCode: null }),
    ).rejects.toThrow("FINALIZATION_REFERENCE_MISMATCH");
    await finalize(1, { fetched: 3, succeeded: 3, failed: 0, cancelled: 0 });
    await expect(finalize(2)).rejects.toThrow("COUNT_VERSION_CONFLICT");
    expect((await context.pool.query("SELECT status FROM crawl_jobs")).rows[0].status).toBe(
      "succeeded",
    );
  });
});
