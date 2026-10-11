CREATE TABLE "collector_api_attempts" (
	"environment" text NOT NULL,
	"operation_key" text NOT NULL,
	"attempt" integer NOT NULL,
	"permit_id" uuid NOT NULL,
	"reserved_tokens" integer NOT NULL,
	"count_version" text NOT NULL,
	"quota_version" text NOT NULL,
	"lease_epoch" bigint NOT NULL,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"status" text DEFAULT 'sent' NOT NULL,
	"usage" jsonb,
	"error_code" text,
	CONSTRAINT "collector_api_attempts_environment_operation_key_attempt_pk" PRIMARY KEY("environment","operation_key","attempt"),
	CONSTRAINT "collector_attempt_number" CHECK ("collector_api_attempts"."attempt" BETWEEN 1 AND 3),
	CONSTRAINT "collector_attempt_tokens" CHECK ("collector_api_attempts"."reserved_tokens" >= 0),
	CONSTRAINT "collector_attempt_status" CHECK ("collector_api_attempts"."status" IN ('sent', 'succeeded', 'failed', 'uncertain', 'rate_limited')),
	CONSTRAINT "collector_attempt_environment" CHECK ("collector_api_attempts"."environment" IN ('staging', 'production'))
);
--> statement-breakpoint
CREATE TABLE "collector_auth_nonces" (
	"environment" text NOT NULL,
	"direction" text NOT NULL,
	"key_id" text NOT NULL,
	"nonce" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collector_auth_nonces_environment_direction_key_id_nonce_pk" PRIMARY KEY("environment","direction","key_id","nonce"),
	CONSTRAINT "collector_nonce_environment" CHECK ("collector_auth_nonces"."environment" IN ('staging', 'production')),
	CONSTRAINT "collector_nonce_direction" CHECK ("collector_auth_nonces"."direction" IN ('cf-to-node', 'node-to-cf'))
);
--> statement-breakpoint
CREATE TABLE "collector_candidates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"discovery_id" uuid NOT NULL,
	"normalized_url" text NOT NULL,
	"metadata" jsonb NOT NULL,
	"article_id" uuid,
	"disposition" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collector_candidate_disposition" CHECK ("collector_candidates"."disposition" IN ('process', 'alreadyPublished'))
);
--> statement-breakpoint
CREATE TABLE "collector_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generation_id" uuid NOT NULL,
	"index" integer NOT NULL,
	"payload" text NOT NULL,
	"input_hash" text NOT NULL,
	"input_tokens" integer,
	"count_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collector_chunk_index" CHECK ("collector_chunks"."index" >= 0),
	CONSTRAINT "collector_chunk_tokens" CHECK ("collector_chunks"."input_tokens" IS NULL OR "collector_chunks"."input_tokens" >= 0)
);
--> statement-breakpoint
CREATE TABLE "collector_discoveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment" text NOT NULL,
	"job_id" uuid NOT NULL,
	"feed_id" text NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"executor_version" text NOT NULL,
	"config_version" text NOT NULL,
	"manifest_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collector_discovery_environment" CHECK ("collector_discoveries"."environment" IN ('staging', 'production'))
);
--> statement-breakpoint
CREATE TABLE "collector_generations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment" text NOT NULL,
	"article_id" uuid NOT NULL,
	"input_hash" text,
	"prompt_version" text NOT NULL,
	"schema_version" text NOT NULL,
	"config_version" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"lease_owner" text,
	"lease_epoch" bigint DEFAULT 0 NOT NULL,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "collector_generation_environment_id_unique" UNIQUE("environment","id"),
	CONSTRAINT "collector_generation_environment" CHECK ("collector_generations"."environment" IN ('staging', 'production')),
	CONSTRAINT "collector_generation_status" CHECK ("collector_generations"."status" IN ('pending', 'running', 'waiting', 'succeeded', 'failed', 'cancelled', 'uncertain')),
	CONSTRAINT "collector_generation_epoch" CHECK ("collector_generations"."lease_epoch" >= 0)
);
--> statement-breakpoint
CREATE TABLE "collector_job_projections" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"environment" text NOT NULL,
	"crawl_job_id" uuid NOT NULL,
	"count_version" integer NOT NULL,
	"counts" jsonb NOT NULL,
	"error_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collector_projection_environment" CHECK ("collector_job_projections"."environment" IN ('staging', 'production')),
	CONSTRAINT "collector_projection_version" CHECK ("collector_job_projections"."count_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "collector_operations" (
	"environment" text NOT NULL,
	"operation_key" text NOT NULL,
	"stage" text NOT NULL,
	"logical_entity_id" text NOT NULL,
	"generation_id" uuid,
	"input_hash" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"schema_version" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"lease_owner" text,
	"lease_epoch" bigint DEFAULT 1 NOT NULL,
	"lease_until" timestamp with time zone,
	"api_attempt" integer DEFAULT 0 NOT NULL,
	"result_id" uuid,
	"next_eligible_at" timestamp with time zone,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "collector_operations_environment_operation_key_pk" PRIMARY KEY("environment","operation_key"),
	CONSTRAINT "collector_operation_environment" CHECK ("collector_operations"."environment" IN ('staging', 'production')),
	CONSTRAINT "collector_operation_status" CHECK ("collector_operations"."status" IN ('running', 'waiting', 'succeeded', 'failed', 'uncertain')),
	CONSTRAINT "collector_operation_stage" CHECK ("collector_operations"."stage" IN ('discovery', 'extract', 'summarize-chunk', 'merge-summary', 'persist', 'job-finalize')),
	CONSTRAINT "collector_operation_epoch" CHECK ("collector_operations"."lease_epoch" > 0),
	CONSTRAINT "collector_operation_lease" CHECK (("collector_operations"."status" = 'running' AND "collector_operations"."lease_owner" IS NOT NULL AND "collector_operations"."lease_until" IS NOT NULL) OR ("collector_operations"."status" <> 'running' AND "collector_operations"."lease_owner" IS NULL AND "collector_operations"."lease_until" IS NULL)),
	CONSTRAINT "collector_operation_result" CHECK ("collector_operations"."status" <> 'succeeded' OR "collector_operations"."result_id" IS NOT NULL),
	CONSTRAINT "collector_operation_wait" CHECK ("collector_operations"."status" <> 'waiting' OR "collector_operations"."next_eligible_at" IS NOT NULL),
	CONSTRAINT "collector_operation_attempt" CHECK ("collector_operations"."api_attempt" BETWEEN 0 AND 3)
);
--> statement-breakpoint
CREATE TABLE "collector_payloads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"generation_id" uuid NOT NULL,
	"content_text" text NOT NULL,
	"content_html" text,
	"extraction_status" text NOT NULL,
	"content_hash" text NOT NULL,
	"chunker_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collector_payload_status" CHECK ("collector_payloads"."extraction_status" IN ('extracted', 'fallback'))
);
--> statement-breakpoint
CREATE TABLE "collector_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"environment" text NOT NULL,
	"operation_key" text NOT NULL,
	"generation_id" uuid,
	"validated_json" jsonb NOT NULL,
	"usage" jsonb NOT NULL,
	"effective_model" text NOT NULL,
	"output_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collector_result_environment" CHECK ("collector_results"."environment" IN ('staging', 'production'))
);
--> statement-breakpoint
ALTER TABLE "collector_api_attempts" ADD CONSTRAINT "collector_api_attempts_environment_operation_key_collector_operations_environment_operation_key_fk" FOREIGN KEY ("environment","operation_key") REFERENCES "public"."collector_operations"("environment","operation_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_candidates" ADD CONSTRAINT "collector_candidates_discovery_id_collector_discoveries_id_fk" FOREIGN KEY ("discovery_id") REFERENCES "public"."collector_discoveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_candidates" ADD CONSTRAINT "collector_candidates_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_chunks" ADD CONSTRAINT "collector_chunks_generation_id_collector_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."collector_generations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_generations" ADD CONSTRAINT "collector_generations_article_id_articles_id_fk" FOREIGN KEY ("article_id") REFERENCES "public"."articles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_job_projections" ADD CONSTRAINT "collector_job_projections_crawl_job_id_crawl_jobs_id_fk" FOREIGN KEY ("crawl_job_id") REFERENCES "public"."crawl_jobs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_operations" ADD CONSTRAINT "collector_operations_environment_generation_id_collector_generations_environment_id_fk" FOREIGN KEY ("environment","generation_id") REFERENCES "public"."collector_generations"("environment","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_payloads" ADD CONSTRAINT "collector_payloads_generation_id_collector_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."collector_generations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_results" ADD CONSTRAINT "collector_results_environment_operation_key_collector_operations_environment_operation_key_fk" FOREIGN KEY ("environment","operation_key") REFERENCES "public"."collector_operations"("environment","operation_key") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_results" ADD CONSTRAINT "collector_results_environment_generation_id_collector_generations_environment_id_fk" FOREIGN KEY ("environment","generation_id") REFERENCES "public"."collector_generations"("environment","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "collector_attempt_permit_unique" ON "collector_api_attempts" USING btree ("permit_id");--> statement-breakpoint
CREATE INDEX "collector_nonce_expiry_idx" ON "collector_auth_nonces" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "collector_candidate_url_unique" ON "collector_candidates" USING btree ("discovery_id","normalized_url");--> statement-breakpoint
CREATE UNIQUE INDEX "collector_chunk_index_unique" ON "collector_chunks" USING btree ("generation_id","index");--> statement-breakpoint
CREATE UNIQUE INDEX "collector_discovery_slot_unique" ON "collector_discoveries" USING btree ("environment","feed_id","scheduled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "collector_active_generation_unique" ON "collector_generations" USING btree ("article_id") WHERE "collector_generations"."status" IN ('pending', 'running', 'waiting', 'uncertain');--> statement-breakpoint
CREATE INDEX "collector_generation_lease_idx" ON "collector_generations" USING btree ("status","lease_until");--> statement-breakpoint
CREATE INDEX "collector_operation_lease_idx" ON "collector_operations" USING btree ("status","lease_until");--> statement-breakpoint
CREATE UNIQUE INDEX "collector_payload_generation_unique" ON "collector_payloads" USING btree ("generation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "collector_result_operation_unique" ON "collector_results" USING btree ("environment","operation_key");