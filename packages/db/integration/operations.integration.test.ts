import {
  operationKey,
  createAuthenticator,
  signRequest,
  type OperationKeyInput,
} from "@upto/domain/batch";
import { sql } from "drizzle-orm";
import { beforeAll, afterAll, afterEach, describe, expect, it } from "vitest";

import { closeDb, createDb } from "../src/client.js";
import { GenerationRepository } from "../src/collector/generations.js";
import { NonceRepository } from "../src/collector/nonces.js";
import { OperationRepository, type ClaimedOperation } from "../src/collector/operations.js";
import { createIntegrationDatabase } from "./database.js";

let context: Awaited<ReturnType<typeof createIntegrationDatabase>>;
let operations: OperationRepository;
let generations: GenerationRepository;
let articleId: string;
const input: OperationKeyInput = {
  environment: "staging",
  stage: "summarize-chunk",
  logicalEntityId: "fixture-chunk",
  inputHash: "a".repeat(64),
  model: "fixture-model",
  promptVersion: "1",
  schemaVersion: "1",
};
const summary = { kind: "chunk" as const, text: "架空chunk要約" };
const result = {
  output: summary,
  effectiveModel: input.model,
  usage: { inputTokens: 10, outputTokens: 5 },
};
async function claim(owner = "owner") {
  const value = await operations.claim({
    ...input,
    operationKey: await operationKey(input),
    owner,
    leaseMs: 360000,
  });
  if (value.status !== "claimed") throw new Error(`Expected claim, got ${value.status}`);
  return value;
}
async function send(value: ClaimedOperation, attempt = 1, permitId = crypto.randomUUID()) {
  return operations.markSent(value.fence, {
    attempt,
    permitId,
    reservedTokens: 11,
    countVersion: "1",
    quotaVersion: "1",
  });
}

beforeAll(async () => {
  context = await createIntegrationDatabase();
  operations = new OperationRepository(context.db);
  generations = new GenerationRepository(context.db);
  const source = await context.pool.query(
    "INSERT INTO sources(name,site_url) VALUES ('fixture','https://fixture.example') RETURNING id",
  );
  const article = await context.pool.query(
    "INSERT INTO articles(source_id,title,original_url,normalized_url) VALUES ($1,'架空記事','https://fixture.example/article','https://fixture.example/article') RETURNING id",
    [source.rows[0].id],
  );
  articleId = article.rows[0].id;
});
afterEach(async () => {
  await context.pool.query("DROP TRIGGER IF EXISTS fail_commit ON collector_operations");
  await context.pool.query(
    "TRUNCATE collector_operations, collector_results, collector_api_attempts, collector_generations CASCADE",
  );
  await context.pool.query("UPDATE articles SET summary_status='pending'");
});
afterAll(async () => {
  await context?.close();
});

describe("operation fencing and recovery on real PostgreSQL", () => {
  it("fences unsent withdrawal and rolls the attempt deletion back on a failed wait commit", async () => {
    const value = await claim();
    const permit = crypto.randomUUID();
    await send(value, 1, permit);
    const withdraw = (fence = value.fence, permitId = permit) =>
      operations.withdrawUnsent(
        fence,
        permitId,
        new Date(Date.now() + 60000),
        "GATE_PERMIT_EXPIRED",
      );
    await expect(withdraw({ ...value.fence, leaseEpoch: 99 })).rejects.toThrow(
      "STALE_OPERATION_OWNER",
    );
    await expect(withdraw(value.fence, crypto.randomUUID())).rejects.toThrow(
      "API_ATTEMPT_REQUIRED",
    );
    await context.pool.query(
      "CREATE FUNCTION fail_withdraw_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_withdraw_failure'; END $$",
    );
    await context.pool.query(
      "CREATE TRIGGER fail_commit BEFORE UPDATE ON collector_operations FOR EACH ROW EXECUTE FUNCTION fail_withdraw_commit()",
    );
    try {
      await expect(withdraw()).rejects.toThrow();
      expect(
        (await context.pool.query("SELECT status,api_attempt FROM collector_operations")).rows[0],
      ).toEqual({ status: "running", api_attempt: 1 });
      expect(
        (await context.pool.query("SELECT status FROM collector_api_attempts")).rows[0].status,
      ).toBe("sent");
    } finally {
      await context.pool.query("DROP TRIGGER fail_commit ON collector_operations");
      await context.pool.query("DROP FUNCTION fail_withdraw_commit()");
    }
    await withdraw();
    expect(
      (await context.pool.query("SELECT status,api_attempt FROM collector_operations")).rows[0],
    ).toEqual({ status: "waiting", api_attempt: 0 });
    expect(
      (await context.pool.query("SELECT count(*)::int AS n FROM collector_api_attempts")).rows[0].n,
    ).toBe(0);
  });
  it("allows only one simultaneous owner across independent database pools", async () => {
    const other = createDb(context.url, { max: 2 });
    try {
      const key = await operationKey(input);
      const claims = await Promise.all([
        operations.claim({ ...input, operationKey: key, owner: "one", leaseMs: 360000 }),
        new OperationRepository(other).claim({
          ...input,
          operationKey: key,
          owner: "two",
          leaseMs: 360000,
        }),
      ]);
      expect(claims.map((value) => value.status).sort()).toEqual(["claimed", "running"]);
      expect(
        (await context.pool.query("SELECT count(*)::int AS count FROM collector_operations"))
          .rows[0].count,
      ).toBe(1);
    } finally {
      await closeDb(other);
    }
  });
  it("rejects an operation key with a different input before mutation", async () => {
    const original = await claim();
    await expect(
      operations.claim({
        ...input,
        inputHash: "b".repeat(64),
        operationKey: original.fence.operationKey,
        owner: "other",
        leaseMs: 360000,
      }),
    ).rejects.toThrow("OPERATION_INPUT_CONFLICT");
    expect(
      (await context.pool.query("SELECT lease_epoch FROM collector_operations")).rows[0]
        .lease_epoch,
    ).toBe("1");
  });
  it("reclaims an expired unsent operation but fences all writes from the old epoch", async () => {
    const original = await claim();
    await context.pool.query(
      "UPDATE collector_operations SET lease_until=clock_timestamp()-interval '1 second'",
    );
    const renewed = await claim("new");
    expect(renewed.fence.leaseEpoch).toBe(2);
    await expect(send(original)).rejects.toThrow("STALE_OPERATION_OWNER");
    await expect(operations.complete(original.fence, result)).rejects.toThrow(
      "STALE_OPERATION_OWNER",
    );
    await send(renewed);
    await operations.complete(renewed.fence, result);
    await expect(operations.fail(original.fence, "LATE_FAILURE")).rejects.toThrow(
      "STALE_OPERATION_OWNER",
    );
    expect((await operations.status("staging", original.fence.operationKey)).status).toBe(
      "succeeded",
    );
  });
  it("refuses even the current owner's commit after the lease deadline", async () => {
    const value = await claim();
    await send(value);
    await context.pool.query(
      "UPDATE collector_operations SET lease_until=clock_timestamp()-interval '1 second'",
    );
    await expect(operations.complete(value.fence, result)).rejects.toThrow("STALE_OPERATION_OWNER");
    expect(
      (await context.pool.query("SELECT count(*)::int AS count FROM collector_results")).rows[0]
        .count,
    ).toBe(0);
  });
  it("converts an expired sent attempt to uncertain and never claims it again", async () => {
    const value = await claim();
    await send(value);
    await context.pool.query(
      "UPDATE collector_operations SET lease_until=clock_timestamp()-interval '1 second'",
    );
    expect(await operations.status("staging", value.fence.operationKey)).toEqual({
      status: "uncertain",
    });
    expect(
      (
        await operations.claim({
          ...input,
          operationKey: value.fence.operationKey,
          owner: "new",
          leaseMs: 360000,
        })
      ).status,
    ).toBe("uncertain");
    expect(
      (await context.pool.query("SELECT status FROM collector_api_attempts")).rows[0].status,
    ).toBe("uncertain");
    expect(
      (await context.pool.query("SELECT api_attempt FROM collector_operations")).rows[0]
        .api_attempt,
    ).toBe(1);
  });
  it("recovers a committed result after response loss without another API attempt", async () => {
    const value = await claim();
    await send(value);
    const saved = await operations.complete(value.fence, result);
    expect(await operations.status("staging", value.fence.operationKey)).toEqual({
      status: "succeeded",
      resultId: saved,
    });
    expect(
      (
        await operations.claim({
          ...input,
          operationKey: value.fence.operationKey,
          owner: "retry",
          leaseMs: 360000,
        })
      ).status,
    ).toBe("succeeded");
    expect(
      (await context.pool.query("SELECT count(*)::int AS count FROM collector_results")).rows[0]
        .count,
    ).toBe(1);
    expect(
      (await context.pool.query("SELECT count(*)::int AS count FROM collector_api_attempts"))
        .rows[0].count,
    ).toBe(1);
    expect(await operations.status("production", value.fence.operationKey)).toEqual({
      status: "not_found",
    });
  });
  it("atomically rolls result/usage back if the final operation write fails", async () => {
    const value = await claim();
    await send(value);
    await context.pool.query(
      "CREATE FUNCTION fail_operation_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='succeeded' THEN RAISE EXCEPTION 'fixture_failure'; END IF; RETURN NEW; END $$",
    );
    await context.pool.query(
      "CREATE TRIGGER fail_commit BEFORE UPDATE ON collector_operations FOR EACH ROW EXECUTE FUNCTION fail_operation_commit()",
    );
    await expect(operations.complete(value.fence, result)).rejects.toThrow();
    expect(
      (await context.pool.query("SELECT count(*)::int AS count FROM collector_results")).rows[0]
        .count,
    ).toBe(0);
    expect(
      (await context.pool.query("SELECT status FROM collector_api_attempts")).rows[0].status,
    ).toBe("sent");
    expect((await operations.status("staging", value.fence.operationKey)).status).toBe("running");
  });
  it("does not increase apiAttempt while waiting for quota and reclaims with a new epoch", async () => {
    const value = await claim();
    await operations.wait(value.fence, new Date(Date.now() + 60000), "QUOTA_WAIT");
    expect(
      (
        await operations.claim({
          ...input,
          operationKey: value.fence.operationKey,
          owner: "other",
          leaseMs: 360000,
        })
      ).status,
    ).toBe("waiting");
    await context.pool.query(
      "UPDATE collector_operations SET next_eligible_at=clock_timestamp()-interval '1 second'",
    );
    const resumed = await claim("resumed");
    expect(resumed.fence.leaseEpoch).toBe(2);
    expect(resumed.apiAttempt).toBe(0);
    await send(resumed);
    expect(
      (await context.pool.query("SELECT api_attempt FROM collector_operations")).rows[0]
        .api_attempt,
    ).toBe(1);
  });
  it("consumes an API attempt once and never permits duplicate or out-of-order sends", async () => {
    const value = await claim();
    const permitId = crypto.randomUUID();
    await send(value, 1, permitId);
    await expect(send(value, 1, permitId)).rejects.toThrow("API_ATTEMPT_CONFLICT");
    await expect(send(value, 2)).rejects.toThrow("API_ATTEMPT_UNRESOLVED");
    await expect(
      operations.complete(value.fence, { ...result, output: { kind: "chunk", text: "" } }),
    ).rejects.toThrow();
    expect(
      (await context.pool.query("SELECT count(*)::int AS count FROM collector_results")).rows[0]
        .count,
    ).toBe(0);
    await operations.complete(value.fence, result);
    await expect(send(value, 2)).rejects.toThrow("STALE_OPERATION_OWNER");
  });
  it("records immediate send uncertainty without releasing an automatic retry", async () => {
    const value = await claim();
    await send(value);
    await operations.uncertain(value.fence);
    expect(await operations.status("staging", value.fence.operationKey)).toEqual({
      status: "uncertain",
    });
    expect(
      (
        await operations.claim({
          ...input,
          operationKey: value.fence.operationKey,
          owner: "retry",
          leaseMs: 360000,
        })
      ).status,
    ).toBe("uncertain");
  });
  it("rolls back generated results when a database statement reaches its timeout", async () => {
    const value = await claim();
    await send(value);
    const deadlineDb = createDb(context.url, { statementTimeoutMs: 100 });
    try {
      await expect(
        new OperationRepository(deadlineDb).complete(value.fence, result, async (tx) => {
          await tx.execute(sql`SELECT pg_sleep(0.5)`);
        }),
      ).rejects.toThrow();
      expect(
        (await context.pool.query("SELECT count(*)::int AS count FROM collector_results")).rows[0]
          .count,
      ).toBe(0);
      expect(
        (await context.pool.query("SELECT status FROM collector_api_attempts")).rows[0].status,
      ).toBe("sent");
      await operations.uncertain(value.fence);
      expect(await operations.status("staging", value.fence.operationKey)).toEqual({
        status: "uncertain",
      });
    } finally {
      await closeDb(deadlineDb);
    }
  });
  it("preserves bounded rate-limit retries without quota waits consuming attempts", async () => {
    let value = await claim();
    for (let attempt = 1; attempt <= 3; attempt++) {
      await send(value, attempt);
      await operations.rateLimited(value.fence, new Date(Date.now() + 60000));
      await context.pool.query(
        "UPDATE collector_operations SET next_eligible_at=clock_timestamp()-interval '1 second'",
      );
      if (attempt < 3) value = await claim(`resume-${attempt}`);
    }
    expect(await operations.status("staging", value.fence.operationKey)).toEqual({
      status: "failed",
      errorCode: "API_ATTEMPTS_EXHAUSTED",
      retryable: false,
    });
    expect(
      (await context.pool.query("SELECT count(*)::int AS count FROM collector_api_attempts"))
        .rows[0].count,
    ).toBe(3);
  });
});

describe("article generation joins", () => {
  const versions = {
    environment: "staging" as const,
    promptVersion: "1",
    schemaVersion: "1",
    configVersion: "1",
  };
  it("joins the same active generation across independent feed/job invocations", async () => {
    const other = createDb(context.url);
    try {
      const results = await Promise.all([
        generations.join({ ...versions, articleId }),
        new GenerationRepository(other).join({ ...versions, articleId }),
      ]);
      expect(results[0]).toEqual(results[1]);
      expect(results[0]?.status).toBe("joined");
      expect(
        (await context.pool.query("SELECT count(*)::int AS count FROM collector_generations"))
          .rows[0].count,
      ).toBe(1);
    } finally {
      await closeDb(other);
    }
  });
  it("never auto-regenerates a previously published article", async () => {
    await context.pool.query("UPDATE articles SET summary_status='summarized'");
    expect(await generations.join({ ...versions, articleId })).toEqual({
      status: "alreadyPublished",
      articleId,
    });
    expect(
      (await context.pool.query("SELECT count(*)::int AS count FROM collector_generations")).rows[0]
        .count,
    ).toBe(0);
  });
  it("rejects environment or config/version confusion when joining", async () => {
    await generations.join({ ...versions, articleId });
    await expect(
      generations.join({ ...versions, articleId, environment: "production" }),
    ).rejects.toThrow("GENERATION_VERSION_CONFLICT");
    await expect(generations.join({ ...versions, articleId, promptVersion: "2" })).rejects.toThrow(
      "GENERATION_VERSION_CONFLICT",
    );
    await expect(generations.join({ ...versions, articleId, configVersion: "2" })).rejects.toThrow(
      "GENERATION_VERSION_CONFLICT",
    );
  });
});

describe("authentication nonce storage", () => {
  it("rejects concurrent replay across independent PG connections", async () => {
    const other = createDb(context.url);
    const input = {
      environment: "staging" as const,
      direction: "cf-to-node" as const,
      keyId: "fixture-key",
      nonce: crypto.randomUUID(),
      retainUntil: new Date(Date.now() + 65000),
    };
    try {
      const accepted = await Promise.all([
        new NonceRepository(context.db).consume(input),
        new NonceRepository(other).consume(input),
      ]);
      expect(accepted.sort()).toEqual([false, true]);
      expect(
        (
          await context.pool.query(
            "SELECT count(*)::int AS count FROM collector_auth_nonces WHERE nonce=$1",
            [input.nonce],
          )
        ).rows[0].count,
      ).toBe(1);
    } finally {
      await closeDb(other);
    }
  });
  it("uses actual HMAC verification before atomically rejecting PG-backed concurrent replay", async () => {
    const other = createDb(context.url);
    const key = new TextEncoder().encode("fixture-auth-key-material-never-real-0001");
    const now = Date.now();
    const nonce = crypto.randomUUID();
    const request = {
      method: "POST",
      url: "https://fixture.example/api/v1/extract",
      body: new TextEncoder().encode("{}"),
    };
    const headers = await signRequest(
      request,
      {
        authVersion: "v1",
        direction: "cf-to-node",
        environment: "staging",
        keyId: "fixture-key",
        executorVersion: "fixture-build",
        requestId: crypto.randomUUID(),
        nonce,
        issuedAt: now,
        expiresAt: now + 60000,
      },
      key,
    );
    const receiver = (db: typeof context.db) =>
      createAuthenticator({
        environment: "staging",
        direction: "cf-to-node",
        allowedExecutorVersions: ["fixture-build"],
        keys: new Map([["fixture-key", key]]),
        consumeNonce: (input) => new NonceRepository(db).consume(input),
      });
    try {
      const results = await Promise.allSettled([
        receiver(context.db).verify({ ...request, headers }),
        receiver(other).verify({ ...request, headers }),
      ]);
      expect(results.filter((value) => value.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((value) => value.status === "rejected")).toHaveLength(1);
      expect(
        (
          await context.pool.query(
            "SELECT count(*)::int AS count FROM collector_auth_nonces WHERE nonce=$1",
            [nonce],
          )
        ).rows[0].count,
      ).toBe(1);
    } finally {
      await closeDb(other);
    }
  });
  it("cleans only expired nonces in the selected environment with a bounded batch", async () => {
    const repo = new NonceRepository(context.db);
    await context.pool.query("TRUNCATE collector_auth_nonces");
    const input = {
      environment: "staging" as const,
      direction: "cf-to-node" as const,
      keyId: "fixture-key",
      retainUntil: new Date(0),
    };
    for (let index = 0; index < 2; index++)
      await repo.consume({ ...input, nonce: crypto.randomUUID() });
    await repo.consume({ ...input, environment: "production", nonce: crypto.randomUUID() });
    await repo.consume({
      ...input,
      retainUntil: new Date(Date.now() + 65000),
      nonce: crypto.randomUUID(),
    });
    expect(await repo.cleanup("staging", 1)).toBe(1);
    expect(
      (await context.pool.query("SELECT count(*)::int AS count FROM collector_auth_nonces")).rows[0]
        .count,
    ).toBe(3);
    expect(await repo.cleanup("staging", 100)).toBe(1);
    expect(
      (await context.pool.query("SELECT count(*)::int AS count FROM collector_auth_nonces")).rows[0]
        .count,
    ).toBe(2);
  });
});
