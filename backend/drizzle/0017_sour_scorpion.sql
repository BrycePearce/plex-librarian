CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` integer,
	`type` text NOT NULL,
	`payload` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `events_server_id_idx` ON `events` (`server_id`,`id`);--> statement-breakpoint
CREATE INDEX `events_created_at_idx` ON `events` (`created_at`);--> statement-breakpoint
CREATE INDEX `sync_log_finished_at_idx` ON `sync_log` (`finished_at`);