import type {
  BatchEnvironment,
  BatchStage,
  ManifestEntry,
  ExtractionInput,
} from "@upto/domain/batch";

import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { articles, crawlJobs } from "../schema-core.js";

export type GenerationState =
  | "pending"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "uncertain";
export type OperationState = "running" | "waiting" | "succeeded" | "failed" | "uncertain";
export type ApiAttemptState = "sent" | "succeeded" | "failed" | "uncertain" | "rate_limited";
const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const environment = () => text("environment").$type<BatchEnvironment>().notNull();
const environmentCheck = (column: unknown) => sql`${column} IN ('staging', 'production')`;

export const collectorDiscoveries = pgTable(
  "collector_discoveries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    environment: environment(),
    jobId: uuid("job_id").notNull(),
    crawlJobId: uuid("crawl_job_id").references(() => crawlJobs.id, { onDelete: "restrict" }),
    feedJobId: uuid("feed_job_id").references(() => crawlJobs.id, { onDelete: "restrict" }),
    feedId: text("feed_id").notNull(),
    scheduledAt: timestamp("scheduled_at", { withTimezone: true }).notNull(),
    executorVersion: text("executor_version").notNull(),
    configVersion: text("config_version").notNull(),
    manifestHash: text("manifest_hash").notNull(),
    inputHash: text("input_hash"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("collector_discovery_slot_unique").on(
      table.environment,
      table.feedId,
      table.scheduledAt,
    ),
    check("collector_discovery_environment", environmentCheck(table.environment)),
  ],
);

export const collectorCandidates = pgTable(
  "collector_candidates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    discoveryId: uuid("discovery_id")
      .notNull()
      .references(() => collectorDiscoveries.id, { onDelete: "restrict" }),
    normalizedUrl: text("normalized_url").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull(),
    articleId: uuid("article_id").references(() => articles.id, { onDelete: "restrict" }),
    disposition: text("disposition").$type<"process" | "alreadyPublished" | "failed">().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("collector_candidate_url_unique").on(table.discoveryId, table.normalizedUrl),
    check(
      "collector_candidate_disposition",
      sql`${table.disposition} IN ('process', 'alreadyPublished', 'failed')`,
    ),
  ],
);

export const collectorGenerations = pgTable(
  "collector_generations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    environment: environment(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => articles.id, { onDelete: "restrict" }),
    inputHash: text("input_hash"),
    promptVersion: text("prompt_version").notNull(),
    schemaVersion: text("schema_version").notNull(),
    configVersion: text("config_version").notNull(),
    status: text("status").$type<GenerationState>().default("pending").notNull(),
    leaseOwner: text("lease_owner"),
    leaseEpoch: bigint("lease_epoch", { mode: "number" }).default(0).notNull(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    createdAt: createdAt(),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
  },
  (table) => [
    unique("collector_generation_environment_id_unique").on(table.environment, table.id),
    uniqueIndex("collector_active_generation_unique")
      .on(table.articleId)
      .where(sql`${table.status} IN ('pending', 'running', 'waiting', 'uncertain')`),
    index("collector_generation_lease_idx").on(table.status, table.leaseUntil),
    check("collector_generation_environment", environmentCheck(table.environment)),
    check(
      "collector_generation_status",
      sql`${table.status} IN ('pending', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'uncertain')`,
    ),
    check("collector_generation_epoch", sql`${table.leaseEpoch} >= 0`),
  ],
);

export const collectorPayloads = pgTable(
  "collector_payloads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    generationId: uuid("generation_id")
      .notNull()
      .references(() => collectorGenerations.id, { onDelete: "restrict" }),
    contentText: text("content_text").notNull(),
    contentHtml: text("content_html"),
    extractionStatus: text("extraction_status").$type<"extracted" | "fallback">().notNull(),
    contentHash: text("content_hash").notNull(),
    chunkerVersion: text("chunker_version").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("collector_payload_generation_unique").on(table.generationId),
    check("collector_payload_status", sql`${table.extractionStatus} IN ('extracted', 'fallback')`),
  ],
);

export const collectorExtractionInputs = pgTable("collector_extraction_inputs", {
  generationId: uuid("generation_id")
    .primaryKey()
    .references(() => collectorGenerations.id, { onDelete: "restrict" }),
  candidateId: uuid("candidate_id")
    .notNull()
    .references(() => collectorCandidates.id, { onDelete: "restrict" }),
  input: jsonb("input").$type<ExtractionInput>().notNull(),
  inputHash: text("input_hash").notNull(),
  createdAt: createdAt(),
});

export const collectorChunks = pgTable(
  "collector_chunks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    generationId: uuid("generation_id")
      .notNull()
      .references(() => collectorGenerations.id, { onDelete: "restrict" }),
    index: integer("index").notNull(),
    payload: text("payload").notNull(),
    inputHash: text("input_hash").notNull(),
    inputTokens: integer("input_tokens"),
    countVersion: text("count_version"),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("collector_chunk_index_unique").on(table.generationId, table.index),
    check("collector_chunk_index", sql`${table.index} >= 0`),
    check("collector_chunk_tokens", sql`${table.inputTokens} IS NULL OR ${table.inputTokens} >= 0`),
  ],
);

export const collectorOperations = pgTable(
  "collector_operations",
  {
    environment: environment(),
    operationKey: text("operation_key").notNull(),
    stage: text("stage").$type<BatchStage>().notNull(),
    logicalEntityId: text("logical_entity_id").notNull(),
    generationId: uuid("generation_id"),
    generationEpoch: bigint("generation_epoch", { mode: "number" }),
    inputHash: text("input_hash").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    schemaVersion: text("schema_version").notNull(),
    status: text("status").$type<OperationState>().default("running").notNull(),
    leaseOwner: text("lease_owner"),
    leaseEpoch: bigint("lease_epoch", { mode: "number" }).default(1).notNull(),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    apiAttempt: integer("api_attempt").default(0).notNull(),
    resultId: uuid("result_id"),
    nextEligibleAt: timestamp("next_eligible_at", { withTimezone: true }),
    errorCode: text("error_code"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
  },
  (table) => [
    primaryKey({ columns: [table.environment, table.operationKey] }),
    foreignKey({
      columns: [table.environment, table.generationId],
      foreignColumns: [collectorGenerations.environment, collectorGenerations.id],
    }),
    index("collector_operation_lease_idx").on(table.status, table.leaseUntil),
    check("collector_operation_environment", environmentCheck(table.environment)),
    check(
      "collector_operation_status",
      sql`${table.status} IN ('running', 'waiting', 'succeeded', 'failed', 'uncertain')`,
    ),
    check(
      "collector_operation_stage",
      sql`${table.stage} IN ('discovery', 'extract', 'summarize-chunk', 'merge-summary', 'persist', 'job-finalize')`,
    ),
    check("collector_operation_epoch", sql`${table.leaseEpoch} > 0`),
    check(
      "collector_operation_lease",
      sql`(${table.status} = 'running' AND ${table.leaseOwner} IS NOT NULL AND ${table.leaseUntil} IS NOT NULL) OR (${table.status} <> 'running' AND ${table.leaseOwner} IS NULL AND ${table.leaseUntil} IS NULL)`,
    ),
    check(
      "collector_operation_result",
      sql`${table.status} <> 'succeeded' OR ${table.resultId} IS NOT NULL`,
    ),
    check(
      "collector_operation_wait",
      sql`${table.status} <> 'waiting' OR ${table.nextEligibleAt} IS NOT NULL`,
    ),
    check("collector_operation_attempt", sql`${table.apiAttempt} BETWEEN 0 AND 3`),
  ],
);

export const collectorResults = pgTable(
  "collector_results",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    environment: environment(),
    operationKey: text("operation_key").notNull(),
    generationId: uuid("generation_id"),
    validatedJson: jsonb("validated_json").$type<Record<string, unknown>>().notNull(),
    usage: jsonb("usage").$type<{ inputTokens: number; outputTokens: number }>().notNull(),
    effectiveModel: text("effective_model").notNull(),
    outputHash: text("output_hash").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    uniqueIndex("collector_result_operation_unique").on(table.environment, table.operationKey),
    foreignKey({
      columns: [table.environment, table.operationKey],
      foreignColumns: [collectorOperations.environment, collectorOperations.operationKey],
    }),
    foreignKey({
      columns: [table.environment, table.generationId],
      foreignColumns: [collectorGenerations.environment, collectorGenerations.id],
    }),
    check("collector_result_environment", environmentCheck(table.environment)),
  ],
);

export const collectorApiAttempts = pgTable(
  "collector_api_attempts",
  {
    environment: environment(),
    operationKey: text("operation_key").notNull(),
    attempt: integer("attempt").notNull(),
    permitId: uuid("permit_id").notNull(),
    reservedTokens: integer("reserved_tokens").notNull(),
    countVersion: text("count_version").notNull(),
    quotaVersion: text("quota_version").notNull(),
    leaseEpoch: bigint("lease_epoch", { mode: "number" }).notNull(),
    sentAt: timestamp("sent_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    status: text("status").$type<ApiAttemptState>().default("sent").notNull(),
    usage: jsonb("usage").$type<{ inputTokens: number; outputTokens: number }>(),
    errorCode: text("error_code"),
  },
  (table) => [
    primaryKey({ columns: [table.environment, table.operationKey, table.attempt] }),
    foreignKey({
      columns: [table.environment, table.operationKey],
      foreignColumns: [collectorOperations.environment, collectorOperations.operationKey],
    }),
    uniqueIndex("collector_attempt_permit_unique").on(table.permitId),
    check("collector_attempt_number", sql`${table.attempt} BETWEEN 1 AND 3`),
    check("collector_attempt_tokens", sql`${table.reservedTokens} >= 0`),
    check(
      "collector_attempt_status",
      sql`${table.status} IN ('sent', 'succeeded', 'failed', 'uncertain', 'rate_limited')`,
    ),
    check("collector_attempt_environment", environmentCheck(table.environment)),
  ],
);

export const collectorAuthNonces = pgTable(
  "collector_auth_nonces",
  {
    environment: environment(),
    direction: text("direction").$type<"cf-to-node" | "node-to-cf">().notNull(),
    keyId: text("key_id").notNull(),
    nonce: text("nonce").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.environment, table.direction, table.keyId, table.nonce] }),
    index("collector_nonce_expiry_idx").on(table.expiresAt),
    check("collector_nonce_environment", environmentCheck(table.environment)),
    check("collector_nonce_direction", sql`${table.direction} IN ('cf-to-node', 'node-to-cf')`),
  ],
);

export const collectorJobProjections = pgTable(
  "collector_job_projections",
  {
    jobId: uuid("job_id").primaryKey(),
    environment: environment(),
    crawlJobId: uuid("crawl_job_id")
      .notNull()
      .references(() => crawlJobs.id, { onDelete: "restrict" }),
    countVersion: integer("count_version").notNull(),
    counts: jsonb("counts")
      .$type<{ fetched: number; succeeded: number; failed: number; cancelled: number }>()
      .notNull(),
    errorCode: text("error_code"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("collector_projection_environment", environmentCheck(table.environment)),
    check("collector_projection_version", sql`${table.countVersion} > 0`),
  ],
);

export const collectorManifests = pgTable(
  "collector_manifests",
  {
    id: uuid("id").primaryKey(),
    environment: environment(),
    kind: text("kind").$type<"candidates" | "chunks" | "results">().notNull(),
    generationId: uuid("generation_id"),
    discoveryId: uuid("discovery_id").references(() => collectorDiscoveries.id, {
      onDelete: "restrict",
    }),
    snapshotHash: text("snapshot_hash").notNull(),
    entryCount: integer("entry_count").notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    foreignKey({
      name: "collector_manifest_generation_fk",
      columns: [table.environment, table.generationId],
      foreignColumns: [collectorGenerations.environment, collectorGenerations.id],
    }),
    check("collector_manifest_environment", environmentCheck(table.environment)),
    check(
      "collector_manifest_parent",
      sql`(${table.kind} = 'candidates' AND ${table.discoveryId} IS NOT NULL AND ${table.generationId} IS NULL) OR (${table.kind} IN ('chunks', 'results') AND ${table.generationId} IS NOT NULL AND ${table.discoveryId} IS NULL)`,
    ),
    check("collector_manifest_count", sql`${table.entryCount} BETWEEN 0 AND 100`),
  ],
);
export const collectorManifestEntries = pgTable(
  "collector_manifest_entries",
  {
    manifestId: uuid("manifest_id")
      .notNull()
      .references(() => collectorManifests.id, { onDelete: "restrict" }),
    position: integer("position").notNull(),
    data: jsonb("data").$type<ManifestEntry>().notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.manifestId, table.position] }),
    check("collector_manifest_position", sql`${table.position} >= 0`),
  ],
);
