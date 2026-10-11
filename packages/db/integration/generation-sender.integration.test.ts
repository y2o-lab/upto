import { operationKey } from "@upto/domain/batch";
import { beforeAll, afterAll, beforeEach, expect, it } from "vitest";

import {
  runGenerationOperation,
  GenerationTransportError,
  type GenerationDependencies,
} from "../../../apps/collector/src/stages/generation-sender.js";
import { createIntegrationDatabase } from "./database.js";
let database: Awaited<ReturnType<typeof createIntegrationDatabase>>;
let generationId: string;
const calls: string[] = [];
const permitId = () => crypto.randomUUID();
function dependencies(): GenerationDependencies {
  return {
    async count() {
      calls.push("count");
      return { inputTokens: 100 };
    },
    gate: {
      async reserve() {
        calls.push("reserve");
        return {
          status: "reserved",
          permitId: permitId(),
          expiresAt: new Date(Date.now() + 5000).toISOString(),
          quotaVersion: "1",
        };
      },
      async consume(input) {
        calls.push("consume");
        return { status: "consumed", permitId: input.permitId };
      },
      async report(input) {
        calls.push("report:" + input.outcome);
        return { status: "reported" };
      },
    },
    async generate() {
      calls.push("generate");
      return {
        output: { kind: "chunk", text: "架空の要約" },
        usage: { inputTokens: 100, outputTokens: 20 },
      };
    },
  };
}
async function input() {
  const identity = {
    environment: "staging" as const,
    stage: "summarize-chunk" as const,
    logicalEntityId: generationId + "/fixture-chunk",
    inputHash: "a".repeat(64),
    model: "fixture-model",
    promptVersion: "1",
    schemaVersion: "1",
  };
  return {
    identity,
    operationKey: await operationKey(identity),
    generationId,
    apiAttempt: 1,
    owner: crypto.randomUUID(),
    prompt: "架空の完全prompt",
    outputKind: "chunk" as const,
    maxOutputTokens: 1000,
    countVersion: "1",
    signal: new AbortController().signal,
  };
}
beforeAll(async () => {
  database = await createIntegrationDatabase();
});
afterAll(async () => {
  await database?.close();
});
beforeEach(async () => {
  calls.length = 0;
  await database.pool.query("TRUNCATE sources CASCADE");
  const source = (
    await database.pool.query(
      "INSERT INTO sources(name,site_url) VALUES ('fixture','https://fixture.example') RETURNING id",
    )
  ).rows[0].id;
  const article = (
    await database.pool.query(
      "INSERT INTO articles(source_id,title,original_url,normalized_url) VALUES ($1,'架空記事','https://fixture.example/article','https://fixture.example/article') RETURNING id",
      [source],
    )
  ).rows[0].id;
  generationId = (
    await database.pool.query(
      "INSERT INTO collector_generations(environment,article_id,prompt_version,schema_version,config_version) VALUES ('staging',$1,'1','1','1') RETURNING id",
      [article],
    )
  ).rows[0].id;
});
it("counts, reserves, consumes and records a single successful API attempt before replay", async () => {
  const request = await input();
  const deps = dependencies();
  const first = await runGenerationOperation(database.db, request, deps);
  expect(first).toMatchObject({ status: "succeeded", stage: "summarize-chunk" });
  expect(calls).toEqual(["count", "reserve", "consume", "generate", "report:succeeded"]);
  expect(await runGenerationOperation(database.db, request, deps)).toEqual(first);
  expect(calls.filter((value) => value === "generate")).toHaveLength(1);
  expect(
    (await database.pool.query("SELECT status FROM collector_api_attempts")).rows[0].status,
  ).toBe("succeeded");
});
it("does not generate or increase apiAttempt when gate quota is waiting", async () => {
  const deps = dependencies();
  deps.gate.reserve = async () => ({
    status: "waiting",
    reason: "DAILY_QUOTA",
    nextEligibleAt: new Date(Date.now() + 60000).toISOString(),
  });
  expect(await runGenerationOperation(database.db, await input(), deps)).toMatchObject({
    status: "waiting",
    reason: "DAILY_QUOTA",
  });
  expect(calls).toEqual(["count"]);
  expect(
    (await database.pool.query("SELECT api_attempt FROM collector_operations")).rows[0].api_attempt,
  ).toBe(0);
});
it("does not send if token counting fails", async () => {
  const deps = dependencies();
  deps.count = async () => {
    throw new Error("fixture-private");
  };
  expect(await runGenerationOperation(database.db, await input(), deps)).toMatchObject({
    status: "waiting",
    reason: "TOKEN_COUNT_UNAVAILABLE",
  });
  expect(
    (await database.pool.query("SELECT count(*)::int AS n FROM collector_api_attempts")).rows[0].n,
  ).toBe(0);
});
it("freezes uncertain sends and blocks a different model on the generation", async () => {
  const deps = dependencies();
  deps.generate = async () => {
    calls.push("generate");
    throw new Error("fixture-network-token");
  };
  const request = await input();
  expect(await runGenerationOperation(database.db, request, deps)).toMatchObject({
    status: "failed",
    errorCode: "GENERATION_OUTCOME_UNKNOWN",
    retryable: false,
  });
  const other = { ...request, identity: { ...request.identity, model: "fallback-model" } };
  other.operationKey = await operationKey(other.identity);
  expect(await runGenerationOperation(database.db, other, dependencies())).toMatchObject({
    status: "failed",
    errorCode: "GENERATION_OUTCOME_UNKNOWN",
  });
  expect(calls.filter((value) => value === "generate")).toHaveLength(1);
  expect(
    (await database.pool.query("SELECT status FROM collector_generations")).rows[0].status,
  ).toBe("uncertain");
});
it("records a known 429 for later retry instead of immediately resending", async () => {
  const deps = dependencies();
  deps.generate = async () => {
    throw new GenerationTransportError("rate_limited");
  };
  expect(await runGenerationOperation(database.db, await input(), deps)).toMatchObject({
    status: "waiting",
    reason: "GEMINI_RATE_LIMITED",
  });
  expect(
    (await database.pool.query("SELECT status FROM collector_api_attempts")).rows[0].status,
  ).toBe("rate_limited");
});
it("rejects invalid output without persisting a result", async () => {
  const deps = dependencies();
  deps.generate = async () => ({
    output: { kind: "chunk", text: "" },
    usage: { inputTokens: 100, outputTokens: 1 },
  });
  expect(await runGenerationOperation(database.db, await input(), deps)).toMatchObject({
    status: "failed",
    errorCode: "GENERATION_OUTPUT_INVALID",
  });
  expect(
    (await database.pool.query("SELECT count(*)::int AS n FROM collector_results")).rows[0].n,
  ).toBe(0);
});
it("rejects expired permits and unknown consume responses without recording an API attempt", async () => {
  const deps = dependencies();
  deps.gate.reserve = async () => ({
    status: "reserved",
    permitId: permitId(),
    expiresAt: new Date(0).toISOString(),
    quotaVersion: "1",
  });
  expect(await runGenerationOperation(database.db, await input(), deps)).toMatchObject({
    status: "waiting",
    reason: "GATE_PERMIT_EXPIRED",
  });
  expect(
    (await database.pool.query("SELECT count(*)::int AS n FROM collector_api_attempts")).rows[0].n,
  ).toBe(0);
  expect(calls).toEqual(["count"]);
});
it("does not send when gate consume is unconfirmed", async () => {
  const deps = dependencies();
  deps.gate.consume = async () => {
    throw new Error("fixture-gate-private");
  };
  expect(await runGenerationOperation(database.db, await input(), deps)).toMatchObject({
    status: "waiting",
    reason: "GATE_CONSUME_UNKNOWN",
  });
  expect(
    (await database.pool.query("SELECT count(*)::int AS n FROM collector_api_attempts")).rows[0].n,
  ).toBe(0);
  expect(calls).not.toContain("generate");
});
it("keeps PG success authoritative if the gate report fails", async () => {
  const deps = dependencies();
  deps.gate.report = async () => {
    throw new Error("fixture-report-private");
  };
  const request = await input();
  expect(await runGenerationOperation(database.db, request, deps)).toMatchObject({
    status: "succeeded",
  });
  expect(await runGenerationOperation(database.db, request, deps)).toMatchObject({
    status: "succeeded",
  });
  expect(calls.filter((value) => value === "generate")).toHaveLength(1);
});
it("persists markSent before generation and counts the exact full prompt", async () => {
  const request = await input();
  const deps = dependencies();
  deps.count = async (value) => {
    expect(value.prompt).toBe(request.prompt);
    expect(value.model).toBe(request.identity.model);
    return { inputTokens: 101 };
  };
  deps.gate.reserve = async (value) => {
    expect(value.inputTokens).toBe(112);
    expect(value.outputTokenLimit).toBe(1000);
    return {
      status: "reserved",
      permitId: permitId(),
      expiresAt: new Date(Date.now() + 5000).toISOString(),
      quotaVersion: "1",
    };
  };
  deps.generate = async (value) => {
    expect(value.prompt).toBe(request.prompt);
    expect(value.model).toBe(request.identity.model);
    expect(
      (await database.pool.query("SELECT status FROM collector_api_attempts")).rows[0].status,
    ).toBe("sent");
    return {
      output: { kind: "chunk", text: "架空の要約" },
      usage: { inputTokens: 101, outputTokens: 20 },
    };
  };
  expect(await runGenerationOperation(database.db, request, deps)).toMatchObject({
    status: "succeeded",
  });
});
it("caps known 429 retries at three sends with a new permit per attempt", async () => {
  const request = await input();
  const deps = dependencies();
  deps.generate = async () => {
    calls.push("generate");
    throw new GenerationTransportError("rate_limited");
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    const value = await runGenerationOperation(
      database.db,
      { ...request, apiAttempt: attempt },
      deps,
    );
    expect(value.status).toBe(attempt === 3 ? "failed" : "waiting");
    if (attempt < 3)
      await database.pool.query(
        "UPDATE collector_operations SET next_eligible_at=now()-interval '1 second'",
      );
  }
  expect(calls.filter((value) => value === "generate")).toHaveLength(3);
  expect(
    (
      await database.pool.query(
        "SELECT count(DISTINCT permit_id)::int AS n FROM collector_api_attempts",
      )
    ).rows[0].n,
  ).toBe(3);
  expect(
    await runGenerationOperation(database.db, { ...request, apiAttempt: 3 }, deps),
  ).toMatchObject({ status: "failed", errorCode: "API_ATTEMPTS_EXHAUSTED" });
});
it("does not generate if PG markSent cannot commit", async () => {
  await database.pool.query(
    "CREATE FUNCTION fail_sender_attempt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture-attempt-failure'; END $$",
  );
  await database.pool.query(
    "CREATE TRIGGER fail_sender_attempt BEFORE INSERT ON collector_api_attempts FOR EACH ROW EXECUTE FUNCTION fail_sender_attempt()",
  );
  try {
    await expect(
      runGenerationOperation(database.db, await input(), dependencies()),
    ).rejects.toMatchObject({ cause: { message: "fixture-attempt-failure" } });
    expect(calls).not.toContain("generate");
    expect(calls).toContain("report:uncertain");
  } finally {
    await database.pool.query("DROP TRIGGER fail_sender_attempt ON collector_api_attempts");
    await database.pool.query("DROP FUNCTION fail_sender_attempt()");
  }
});
it("does not send with a permit that expires during markSent and preserves the unsent attempt for retry", async () => {
  const request = await input();
  const deps = dependencies();
  deps.gate.reserve = async () => ({
    status: "reserved",
    permitId: permitId(),
    expiresAt: new Date(Date.now() + 200).toISOString(),
    quotaVersion: "1",
  });
  await database.pool.query(
    "CREATE FUNCTION delay_sender_attempt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.3); RETURN NEW; END $$",
  );
  await database.pool.query(
    "CREATE TRIGGER delay_sender_attempt BEFORE INSERT ON collector_api_attempts FOR EACH ROW EXECUTE FUNCTION delay_sender_attempt()",
  );
  try {
    expect(await runGenerationOperation(database.db, request, deps)).toMatchObject({
      status: "waiting",
      reason: "GATE_PERMIT_EXPIRED",
    });
    expect(calls).not.toContain("generate");
    expect(
      (await database.pool.query("SELECT api_attempt,status FROM collector_operations")).rows[0],
    ).toEqual({ api_attempt: 0, status: "waiting" });
    expect(
      (await database.pool.query("SELECT count(*)::int AS n FROM collector_api_attempts")).rows[0]
        .n,
    ).toBe(0);
  } finally {
    await database.pool.query("DROP TRIGGER delay_sender_attempt ON collector_api_attempts");
    await database.pool.query("DROP FUNCTION delay_sender_attempt()");
  }
  await database.pool.query(
    "UPDATE collector_operations SET next_eligible_at=now()-interval '1 second'",
  );
  expect(await runGenerationOperation(database.db, request, dependencies())).toMatchObject({
    status: "succeeded",
  });
  expect(calls.filter((value) => value === "generate")).toHaveLength(1);
});
async function prepareChunkStage(chunkCount: number) {
  const { PayloadRepository, OperationRepository } = await import("../src/collector/index.js");
  const { createSummarizeChunkStage } =
    await import("../../../apps/collector/src/stages/summarize-chunk.js");
  const identity = {
    environment: "staging" as const,
    stage: "extract" as const,
    logicalEntityId: generationId,
    inputHash: "a".repeat(64),
    model: "",
    promptVersion: "1",
    schemaVersion: "1",
  };
  const claim = await new OperationRepository(database.db).claim({
    ...identity,
    generationId,
    operationKey: await operationKey(identity),
    owner: "fixture",
    leaseMs: 360000,
  });
  if (claim.status !== "claimed") throw new Error("Expected extraction claim");
  const chunks = Array.from({ length: chunkCount }, (_, index) => `架空本文${index}`);
  await new PayloadRepository(
    database.db,
    new TextEncoder().encode("fixture-cursor-material-not-secret-0001"),
  ).saveExtraction(claim.fence, {
    generationId,
    contentText: chunks.join(""),
    contentHtml: null,
    chunks,
    chunkerVersion: "1",
    extractionStatus: "fallback",
  });
  const jobId = crypto.randomUUID();
  const discovery = (
    await database.pool.query(
      "INSERT INTO collector_discoveries(environment,job_id,feed_id,scheduled_at,executor_version,config_version,manifest_hash) VALUES ('staging',$1,'fixture',now(),'1','1',$2) RETURNING id",
      [jobId, "a".repeat(64)],
    )
  ).rows[0].id;
  await database.pool.query(
    "INSERT INTO collector_candidates(discovery_id,normalized_url,article_id,disposition,metadata) SELECT $1,'https://fixture.example/article',article_id,'process',$2 FROM collector_generations WHERE id=$3",
    [discovery, JSON.stringify({ generationId }), generationId],
  );
  const chunkId = (
    await database.pool.query("SELECT id FROM collector_chunks ORDER BY index LIMIT 1")
  ).rows[0].id;
  const request = {
    apiVersion: "v1" as const,
    environment: "staging" as const,
    stage: "summarize-chunk" as const,
    jobId,
    workId: crypto.randomUUID(),
    operationKey: "a".repeat(64),
    executorVersion: "1",
    configVersion: "1",
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
    generationId,
    chunkId,
    modelTier: "primary" as const,
    apiAttempt: 1,
  };
  const deps = dependencies();
  if (chunkCount === 1)
    deps.generate = async () => ({
      output: {
        kind: "summary",
        summary: {
          title: "架空要約",
          difficulty: "beginner",
          importanceScore: 40,
          keyPoints: ["架空ポイント"],
          oneLineSummary: "架空短文",
          summary: "架空要約本文",
          tags: [],
          whyItMatters: "架空理由",
        },
      },
      usage: { inputTokens: 100, outputTokens: 20 },
    });
  const stage = createSummarizeChunkStage({
    db: database.db,
    configVersion: "1",
    executorVersion: "1",
    promptVersion: "1",
    schemaVersion: "1",
    primaryModel: "fixture-primary",
    fallbackModel: "fixture-fallback",
    maxOutputTokens: 1000,
    countVersion: "1",
    dependencies: deps,
  });
  request.operationKey = await operationKey((await stage.resolve(request)).identity);
  const now = Date.now();
  const context = {
    auth: {
      authVersion: "v1" as const,
      environment: "staging" as const,
      direction: "cf-to-node" as const,
      requestId: crypto.randomUUID(),
      nonce: crypto.randomUUID(),
      issuedAt: now,
      expiresAt: now + 60000,
      keyId: "fixture",
      executorVersion: "1",
    },
    signal: new AbortController().signal,
    deadlineAt: now + 60000,
    assertTimeLeft() {},
  };
  return { stage, request, context, deps };
}
it("resolves an authorized stored chunk and produces a final summary for a one-chunk article", async () => {
  const { stage, request, context } = await prepareChunkStage(1);
  const result = await stage.execute(request, context);
  expect(result).toMatchObject({ status: "succeeded", effectiveModel: "fixture-primary" });
  expect(await stage.execute(request, context)).toEqual(result);
  expect(
    (
      await database.pool.query(
        "SELECT validated_json FROM collector_results WHERE effective_model='fixture-primary'",
      )
    ).rows[0].validated_json.kind,
  ).toBe("summary");
});
it("uses chunk output for a multi-chunk article and rejects a foreign job or altered payload", async () => {
  const { stage, request, context } = await prepareChunkStage(2);
  await expect(stage.resolve({ ...request, jobId: crypto.randomUUID() })).rejects.toThrow(
    "SUMMARY_REFERENCE_MISMATCH",
  );
  expect(await stage.execute(request, context)).toMatchObject({ status: "succeeded" });
  expect(
    (
      await database.pool.query(
        "SELECT validated_json FROM collector_results WHERE effective_model='fixture-primary'",
      )
    ).rows[0].validated_json.kind,
  ).toBe("chunk");
  await database.pool.query("UPDATE collector_chunks SET payload='改変した架空本文' WHERE id=$1", [
    request.chunkId,
  ]);
  await expect(stage.resolve(request)).rejects.toThrow("SUMMARY_INPUT_INTEGRITY_MISMATCH");
});
it("reports valid usage even when a completed model output is invalid", async () => {
  const deps = dependencies();
  deps.generate = async () => ({ output: null, usage: { inputTokens: 300, outputTokens: 20 } });
  let reported: unknown;
  deps.gate.report = async (value) => {
    reported = value;
    return { status: "reported" };
  };
  expect(await runGenerationOperation(database.db, await input(), deps)).toMatchObject({
    status: "failed",
    errorCode: "GENERATION_OUTPUT_INVALID",
  });
  expect(reported).toMatchObject({ outcome: "failed", inputTokens: 300, outputTokens: 20 });
  expect(
    (await database.pool.query("SELECT usage FROM collector_api_attempts")).rows[0].usage,
  ).toEqual({ inputTokens: 300, outputTokens: 20 });
});
