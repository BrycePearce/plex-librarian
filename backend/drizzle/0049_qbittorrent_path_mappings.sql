CREATE TABLE `qbittorrent_path_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` integer NOT NULL,
	`instance_key` text NOT NULL,
	`qbittorrent_path` text NOT NULL,
	`local_path` text NOT NULL,
	`case_sensitive` integer DEFAULT true NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	`validation_qbittorrent_path` text NOT NULL,
	`validation_local_path` text NOT NULL,
	`validation_size` integer NOT NULL,
	`validated_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `qbittorrent_path_mappings_instance_idx` ON `qbittorrent_path_mappings` (`server_id`,`instance_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `qbittorrent_path_mappings_unique_prefix` ON `qbittorrent_path_mappings` (`server_id`,`instance_key`,`qbittorrent_path`);
