CREATE TABLE `seerr_instances` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` integer NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`api_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `seerr_instances_server_idx` ON `seerr_instances` (`server_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `seerr_instances_server_url_unique` ON `seerr_instances` (`server_id`,`url`);