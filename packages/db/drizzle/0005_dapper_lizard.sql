CREATE TABLE "collector_manifest_entries" (
	"manifest_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"data" jsonb NOT NULL,
	CONSTRAINT "collector_manifest_entries_manifest_id_position_pk" PRIMARY KEY("manifest_id","position"),
	CONSTRAINT "collector_manifest_position" CHECK ("collector_manifest_entries"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "collector_manifests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"environment" text NOT NULL,
	"kind" text NOT NULL,
	"generation_id" uuid,
	"discovery_id" uuid,
	"snapshot_hash" text NOT NULL,
	"entry_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "collector_manifest_environment" CHECK ("collector_manifests"."environment" IN ('staging', 'production')),
	CONSTRAINT "collector_manifest_parent" CHECK (("collector_manifests"."kind" = 'candidates' AND "collector_manifests"."discovery_id" IS NOT NULL AND "collector_manifests"."generation_id" IS NULL) OR ("collector_manifests"."kind" IN ('chunks', 'results') AND "collector_manifests"."generation_id" IS NOT NULL AND "collector_manifests"."discovery_id" IS NULL)),
	CONSTRAINT "collector_manifest_count" CHECK ("collector_manifests"."entry_count" BETWEEN 0 AND 100)
);
--> statement-breakpoint
ALTER TABLE "collector_manifest_entries" ADD CONSTRAINT "collector_manifest_entries_manifest_id_collector_manifests_id_fk" FOREIGN KEY ("manifest_id") REFERENCES "public"."collector_manifests"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_manifests" ADD CONSTRAINT "collector_manifests_discovery_id_collector_discoveries_id_fk" FOREIGN KEY ("discovery_id") REFERENCES "public"."collector_discoveries"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_manifests" ADD CONSTRAINT "collector_manifest_generation_fk" FOREIGN KEY ("environment","generation_id") REFERENCES "public"."collector_generations"("environment","id") ON DELETE no action ON UPDATE no action;