CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"target_id" text,
	"action" text NOT NULL,
	"outcome" text NOT NULL,
	"minimal_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"unique_key" text NOT NULL,
	"payload_reference" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"locked_by" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "job_queue_type_unique_key_uq" UNIQUE("type","unique_key"),
	CONSTRAINT "job_queue_status_chk" CHECK ("job_queue"."status" in ('pending','running','succeeded','dead')),
	CONSTRAINT "job_queue_attempts_chk" CHECK ("job_queue"."attempts" >= 0 and "job_queue"."max_attempts" >= 1)
);
--> statement-breakpoint
CREATE INDEX "audit_events_user_idx" ON "audit_events" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "job_queue_claim_idx" ON "job_queue" USING btree ("status","available_at");