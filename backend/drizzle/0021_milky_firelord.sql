CREATE TABLE `user_ip_history` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`ip` text NOT NULL,
	`viewed_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_ip_history_account_idx` ON `user_ip_history` (`server_id`,`account_id`,`viewed_at`);
