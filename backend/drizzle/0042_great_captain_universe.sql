CREATE TABLE `seerr_requests` (
	`server_id` integer NOT NULL,
	`seerr_instance_id` integer NOT NULL,
	`request_id` integer NOT NULL,
	`account_id` integer,
	`requester_username` text,
	`requester_email` text,
	`rating_key` text,
	`request_status` integer NOT NULL,
	`media_status` integer NOT NULL,
	`requested_at` integer NOT NULL,
	`available_at` integer,
	`availability_estimated` integer DEFAULT false NOT NULL,
	`synced_at` integer NOT NULL,
	PRIMARY KEY(`seerr_instance_id`, `request_id`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`seerr_instance_id`) REFERENCES `seerr_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `seerr_requests_account_available_idx` ON `seerr_requests` (`server_id`,`account_id`,`available_at`);--> statement-breakpoint
CREATE INDEX `seerr_requests_instance_sync_idx` ON `seerr_requests` (`seerr_instance_id`,`synced_at`);--> statement-breakpoint
CREATE TABLE `user_item_activity` (
	`server_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`rating_key` text NOT NULL,
	`first_viewed_at` integer NOT NULL,
	`last_viewed_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `account_id`, `rating_key`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_item_activity_account_idx` ON `user_item_activity` (`server_id`,`account_id`);--> statement-breakpoint
ALTER TABLE `seerr_instances` ADD `requests_synced_at` integer;--> statement-breakpoint
ALTER TABLE `seerr_instances` ADD `requests_sync_error` text;--> statement-breakpoint
ALTER TABLE `settings` ADD `request_follow_through_grace_days` integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE `settings` ADD `request_follow_through_min_requests` integer DEFAULT 5 NOT NULL;