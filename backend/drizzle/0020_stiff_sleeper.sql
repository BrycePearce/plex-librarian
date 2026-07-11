CREATE TABLE `users` (
	`server_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`local_account_id` integer,
	`username` text NOT NULL,
	`email` text,
	`thumb` text,
	`is_owner` integer DEFAULT false NOT NULL,
	`last_viewed_at` integer,
	`last_ip` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `account_id`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `users_last_viewed_at_idx` ON `users` (`server_id`,`last_viewed_at`);--> statement-breakpoint
CREATE INDEX `users_local_account_idx` ON `users` (`server_id`,`local_account_id`);--> statement-breakpoint
ALTER TABLE `servers` ADD `users_synced_at` integer;--> statement-breakpoint
ALTER TABLE `settings` ADD `inactive_user_days` integer DEFAULT 30 NOT NULL;