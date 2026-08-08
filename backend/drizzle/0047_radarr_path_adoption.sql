CREATE TABLE `plex_path_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` integer NOT NULL,
	`library_key` text NOT NULL,
	`plex_path` text NOT NULL,
	`local_path` text NOT NULL,
	`case_sensitive` integer DEFAULT 1 NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`validation_plex_path` text NOT NULL,
	`validation_local_path` text NOT NULL,
	`validation_size` integer NOT NULL,
	`validated_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`,`library_key`) REFERENCES `libraries`(`server_id`,`key`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `plex_path_mappings_library_idx` ON `plex_path_mappings` (`server_id`,`library_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `plex_path_mappings_unique_prefix` ON `plex_path_mappings` (`server_id`,`library_key`,`plex_path`);--> statement-breakpoint
CREATE TABLE `radarr_movie_reservations` (
	`server_id` integer NOT NULL,
	`arr_instance_id` integer NOT NULL,
	`movie_id` integer NOT NULL,
	`operation_id` text NOT NULL,
	`target_id` integer NOT NULL,
	`plan_fingerprint` text NOT NULL,
	`state` text DEFAULT 'reserved' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `arr_instance_id`, `movie_id`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`arr_instance_id`) REFERENCES `arr_instances`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`operation_id`) REFERENCES `deletion_operations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `deletion_targets`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `radarr_movie_reservations_operation_idx` ON `radarr_movie_reservations` (`operation_id`);
