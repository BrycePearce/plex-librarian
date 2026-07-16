CREATE TABLE `arr_path_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`arr_instance_id` integer NOT NULL,
	`kind` text NOT NULL,
	`arr_path` text NOT NULL,
	`local_path` text NOT NULL,
	FOREIGN KEY (`arr_instance_id`) REFERENCES `arr_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `arr_path_mappings_instance_idx` ON `arr_path_mappings` (`arr_instance_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `arr_path_mappings_unique` ON `arr_path_mappings` (`arr_instance_id`,`kind`,`arr_path`);--> statement-breakpoint
CREATE TABLE `download_file_delete_attempts` (
	`server_id` integer NOT NULL,
	`rating_key` text NOT NULL,
	`local_path` text NOT NULL,
	`root_path` text NOT NULL,
	`root_device` text NOT NULL,
	`root_inode` text NOT NULL,
	`started_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `rating_key`, `local_path`),
	FOREIGN KEY (`server_id`,`rating_key`) REFERENCES `items`(`server_id`,`rating_key`) ON UPDATE no action ON DELETE cascade
);
