CREATE TABLE `qbittorrent_instances` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` integer NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`username` text NOT NULL,
	`password` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `qbittorrent_instances_server_idx` ON `qbittorrent_instances` (`server_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `qbittorrent_instances_server_url_unique` ON `qbittorrent_instances` (`server_id`,`url`);--> statement-breakpoint
CREATE TABLE `torrent_delete_attempts` (
	`server_id` integer NOT NULL,
	`rating_key` text NOT NULL,
	`instance_key` text NOT NULL,
	`torrent_hash` text NOT NULL,
	`started_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `rating_key`, `instance_key`, `torrent_hash`),
	FOREIGN KEY (`server_id`,`rating_key`) REFERENCES `items`(`server_id`,`rating_key`) ON UPDATE no action ON DELETE cascade
);
