CREATE TABLE "web_email_challenges" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "web_email_identities" (
	"email" text PRIMARY KEY NOT NULL,
	"subscriber_id" integer NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_email_identities_subscriber_id_unique" UNIQUE("subscriber_id")
);
--> statement-breakpoint
ALTER TABLE "web_email_identities" ADD CONSTRAINT "web_email_identities_subscriber_id_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "web_email_challenges_email_idx" ON "web_email_challenges" USING btree ("email");--> statement-breakpoint
CREATE INDEX "web_email_challenges_expires_idx" ON "web_email_challenges" USING btree ("expires_at");