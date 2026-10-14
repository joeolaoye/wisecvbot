CREATE TABLE "dead_letters" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"error" text NOT NULL,
	"payload_sample" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" serial PRIMARY KEY NOT NULL,
	"subscriber_id" integer,
	"type" text NOT NULL,
	"payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"company" text NOT NULL,
	"title" text NOT NULL,
	"url" text NOT NULL,
	"location" text,
	"remote" boolean DEFAULT false NOT NULL,
	"salary_min" integer,
	"salary_max" integer,
	"salary_currency" text DEFAULT 'USD' NOT NULL,
	"description_text" text NOT NULL,
	"role_family" text NOT NULL,
	"seniority" text NOT NULL,
	"skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" vector(1536),
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "llm_spend" (
	"day" text PRIMARY KEY NOT NULL,
	"cents" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"id" serial PRIMARY KEY NOT NULL,
	"subscriber_id" integer NOT NULL,
	"job_id" integer NOT NULL,
	"sim_score" double precision DEFAULT 0 NOT NULL,
	"fit_score" integer,
	"rationale" jsonb,
	"status" text DEFAULT 'sent' NOT NULL,
	"feedback" text,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscribers" (
	"id" serial PRIMARY KEY NOT NULL,
	"channel" text DEFAULT 'telegram' NOT NULL,
	"channel_user_id" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"profile" jsonb,
	"profile_embedding" vector(1536),
	"cv_blob" "bytea",
	"cv_filename" text,
	"match_threshold" double precision DEFAULT 0.62 NOT NULL,
	"consent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "matches" ADD CONSTRAINT "matches_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_created_idx" ON "events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_key_uq" ON "jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "jobs_last_seen_idx" ON "jobs" USING btree ("last_seen");--> statement-breakpoint
CREATE INDEX "jobs_role_family_idx" ON "jobs" USING btree ("role_family");--> statement-breakpoint
CREATE UNIQUE INDEX "matches_sub_job_uq" ON "matches" USING btree ("subscriber_id","job_id");--> statement-breakpoint
CREATE INDEX "matches_sub_sent_idx" ON "matches" USING btree ("subscriber_id","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscribers_channel_user_uq" ON "subscribers" USING btree ("channel","channel_user_id");