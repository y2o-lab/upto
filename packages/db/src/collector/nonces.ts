import { environmentSchema, type BatchEnvironment } from "@upto/domain/batch";
import { sql } from "drizzle-orm";

import type { DbClient } from "../client.js";

import { collectorAuthNonces as nonces } from "./schema.js";

export class NonceRepository {
  constructor(private readonly db: DbClient) {}
  async consume(input: {
    environment: BatchEnvironment;
    direction: "cf-to-node" | "node-to-cf";
    keyId: string;
    nonce: string;
    retainUntil: Date;
  }): Promise<boolean> {
    environmentSchema.parse(input.environment);
    if (
      !["cf-to-node", "node-to-cf"].includes(input.direction) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.keyId) ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(input.nonce) ||
      !Number.isFinite(input.retainUntil.getTime())
    )
      throw new Error("INVALID_AUTH_NONCE");
    const [saved] = await this.db
      .insert(nonces)
      .values({
        environment: input.environment,
        direction: input.direction,
        keyId: input.keyId,
        nonce: input.nonce,
        expiresAt: input.retainUntil,
      })
      .onConflictDoNothing()
      .returning({ nonce: nonces.nonce });
    return saved !== undefined;
  }
  async cleanup(environment: BatchEnvironment, limit = 100): Promise<number> {
    environmentSchema.parse(environment);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new Error("INVALID_CLEANUP_LIMIT");
    const result = await this.db.execute(sql`WITH expired AS (
      SELECT environment, direction, key_id, nonce FROM ${nonces}
      WHERE environment = ${environment} AND expires_at <= clock_timestamp()
      ORDER BY expires_at, nonce LIMIT ${limit} FOR UPDATE SKIP LOCKED
    ) DELETE FROM ${nonces} n USING expired e
      WHERE n.environment=e.environment AND n.direction=e.direction AND n.key_id=e.key_id AND n.nonce=e.nonce
      RETURNING n.nonce`);
    return result.rowCount ?? 0;
  }
}
