CREATE TABLE `arr_instances` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` integer NOT NULL,
	`type` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`api_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `arr_instances_server_idx` ON `arr_instances` (`server_id`);--> statement-breakpoint
CREATE TABLE `arr_library_mappings` (
	`server_id` integer NOT NULL,
	`library_key` text NOT NULL,
	`arr_instance_id` integer NOT NULL,
	`add_import_exclusion` integer DEFAULT true NOT NULL,
	PRIMARY KEY(`server_id`, `library_key`, `arr_instance_id`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`arr_instance_id`) REFERENCES `arr_instances`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`,`library_key`) REFERENCES `libraries`(`server_id`,`key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `arr_library_mappings_library_idx` ON `arr_library_mappings` (`server_id`,`library_key`);--> statement-breakpoint
ALTER TABLE `items` ADD `tmdb_id` integer;--> statement-breakpoint
ALTER TABLE `items` ADD `tvdb_id` integer;
