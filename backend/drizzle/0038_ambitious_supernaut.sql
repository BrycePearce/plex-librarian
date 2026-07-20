PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`public_jwk` text,
	`private_jwk` text,
	`active_server_id` integer,
	`auto_sync_enabled` integer DEFAULT true NOT NULL,
	`auto_sync_hour` integer DEFAULT 3 NOT NULL,
	`auto_sync_time_zone` text DEFAULT 'UTC',
	`auto_sync_catch_up` integer DEFAULT true NOT NULL,
	`stale_min_age_days` integer DEFAULT 90 NOT NULL,
	`inactive_user_days` integer DEFAULT 30 NOT NULL,
	`pending_invite_stale_days` integer DEFAULT 30 NOT NULL,
	`pending_invite_critical_days` integer DEFAULT 90 NOT NULL,
	`ip_history_retention_days` integer DEFAULT 365 NOT NULL,
	FOREIGN KEY (`active_server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_settings`("id", "client_id", "public_jwk", "private_jwk", "active_server_id", "auto_sync_enabled", "auto_sync_hour", "auto_sync_time_zone", "auto_sync_catch_up", "stale_min_age_days", "inactive_user_days", "pending_invite_stale_days", "pending_invite_critical_days", "ip_history_retention_days") SELECT "id", "client_id", "public_jwk", "private_jwk", "active_server_id", "auto_sync_enabled", "auto_sync_hour", NULL, true, "stale_min_age_days", "inactive_user_days", "pending_invite_stale_days", "pending_invite_critical_days", "ip_history_retention_days" FROM `settings`;--> statement-breakpoint
DROP TABLE `settings`;--> statement-breakpoint
ALTER TABLE `__new_settings` RENAME TO `settings`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
