CREATE TABLE `media_removals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` integer NOT NULL,
	`operation_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_key` text NOT NULL,
	`media_size` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `media_removals_server_id_idx` ON `media_removals` (`server_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_removals_operation_target_unique` ON `media_removals` (`server_id`,`operation_id`,`target_kind`,`target_key`);