CREATE TABLE "app"."passkeys" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"public_key" text NOT NULL,
	"user_id" text NOT NULL,
	"credential_id" text NOT NULL,
	"counter" integer NOT NULL,
	"device_type" text NOT NULL,
	"backed_up" boolean NOT NULL,
	"transports" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"aaguid" text,
	CONSTRAINT "passkeys_counter_non_negative" CHECK ("app"."passkeys"."counter" >= 0)
);
--> statement-breakpoint
ALTER TABLE "app"."sessions" ADD COLUMN "auth_method" text;--> statement-breakpoint
ALTER TABLE "app"."passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "passkeys_credential_id_key" ON "app"."passkeys" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "passkeys_user_idx" ON "app"."passkeys" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "app"."sessions" ADD CONSTRAINT "sessions_auth_method_known" CHECK ("app"."sessions"."auth_method" is null or "app"."sessions"."auth_method" in ('passkey', 'magic_link', 'discord'));