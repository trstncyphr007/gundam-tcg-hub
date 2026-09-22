CREATE TABLE "app"."sign_in_devices" (
	"user_id" text NOT NULL,
	"device" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sign_in_devices_user_id_device_pk" PRIMARY KEY("user_id","device"),
	CONSTRAINT "sign_in_devices_device_short" CHECK (length("app"."sign_in_devices"."device") between 1 and 64)
);
--> statement-breakpoint
ALTER TABLE "app"."sign_in_devices" ADD CONSTRAINT "sign_in_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."users"("id") ON DELETE cascade ON UPDATE no action;