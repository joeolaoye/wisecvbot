CREATE TABLE "web_auth_challenges" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"phone" text NOT NULL,
	"method" text NOT NULL,
	"code_hash" text,
	"telegram_user_id" text,
	"subscriber_id" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_auth_identities" (
	"phone" text PRIMARY KEY NOT NULL,
	"subscriber_id" integer NOT NULL,
	"verified_via" text NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_auth_identities_subscriber_id_unique" UNIQUE("subscriber_id")
);
--> statement-breakpoint
CREATE TABLE "web_conversations" (
	"subscriber_id" integer PRIMARY KEY NOT NULL,
	"state" text DEFAULT 'idle' NOT NULL,
	"draft" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"subscriber_id" integer NOT NULL,
	"role" text NOT NULL,
	"body" text NOT NULL,
	"actions" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"subscriber_id" integer NOT NULL,
	"csrf_token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "web_auth_challenges" ADD CONSTRAINT "web_auth_challenges_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_auth_identities" ADD CONSTRAINT "web_auth_identities_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_conversations" ADD CONSTRAINT "web_conversations_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_messages" ADD CONSTRAINT "web_messages_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "web_sessions" ADD CONSTRAINT "web_sessions_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "web_auth_challenges_expires_idx" ON "web_auth_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "web_messages_subscriber_idx" ON "web_messages" USING btree ("subscriber_id","created_at");--> statement-breakpoint
CREATE INDEX "web_sessions_subscriber_idx" ON "web_sessions" USING btree ("subscriber_id");