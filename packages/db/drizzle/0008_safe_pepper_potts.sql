CREATE TABLE "collector_extraction_inputs" (
	"generation_id" uuid PRIMARY KEY NOT NULL,
	"candidate_id" uuid NOT NULL,
	"input" jsonb NOT NULL,
	"input_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "collector_extraction_inputs" ADD CONSTRAINT "collector_extraction_inputs_generation_id_collector_generations_id_fk" FOREIGN KEY ("generation_id") REFERENCES "public"."collector_generations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "collector_extraction_inputs" ADD CONSTRAINT "collector_extraction_inputs_candidate_id_collector_candidates_id_fk" FOREIGN KEY ("candidate_id") REFERENCES "public"."collector_candidates"("id") ON DELETE restrict ON UPDATE no action;