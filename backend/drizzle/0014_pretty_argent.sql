CREATE TABLE `servers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`machine_identifier` text NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`access_token` text NOT NULL,
	`last_connected_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `servers_machine_identifier_unique` ON `servers` (`machine_identifier`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_items` (
	`server_id` integer NOT NULL,
	`rating_key` text NOT NULL,
	`library_key` text NOT NULL,
	`title` text NOT NULL,
	`type` text NOT NULL,
	`thumb` text,
	`added_at` integer,
	`last_viewed_at` integer,
	`view_count` integer DEFAULT 0,
	`file_size` integer,
	`duration` integer,
	`year` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `rating_key`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`,`library_key`) REFERENCES `libraries`(`server_id`,`key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- No copy-over: pre-scoping rows have no reliable server_id to carry forward (item/library
-- keys aren't unique across Plex servers), and DROP TABLE discards them regardless.
DROP TABLE `items`;--> statement-breakpoint
ALTER TABLE `__new_items` RENAME TO `items`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `items_last_viewed_at_idx` ON `items` (`server_id`,`last_viewed_at`);--> statement-breakpoint
CREATE INDEX `items_library_stale_idx` ON `items` (`server_id`,`library_key`,`last_viewed_at`);--> statement-breakpoint
CREATE INDEX `items_library_file_size_idx` ON `items` (`server_id`,`library_key`,`file_size`);--> statement-breakpoint
CREATE TABLE `__new_seasons` (
	`server_id` integer NOT NULL,
	`rating_key` text NOT NULL,
	`show_rating_key` text NOT NULL,
	`library_key` text NOT NULL,
	`season_index` integer NOT NULL,
	`title` text NOT NULL,
	`file_size` integer,
	`duration` integer,
	`leaf_count` integer,
	`view_count` integer DEFAULT 0,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `rating_key`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`,`show_rating_key`) REFERENCES `items`(`server_id`,`rating_key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`,`library_key`) REFERENCES `libraries`(`server_id`,`key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- No copy-over: see note above `items`.
DROP TABLE `seasons`;--> statement-breakpoint
ALTER TABLE `__new_seasons` RENAME TO `seasons`;--> statement-breakpoint
CREATE INDEX `seasons_show_idx` ON `seasons` (`server_id`,`show_rating_key`);--> statement-breakpoint
CREATE INDEX `seasons_library_idx` ON `seasons` (`server_id`,`library_key`);--> statement-breakpoint
CREATE TABLE `__new_libraries` (
	`server_id` integer NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`type` text NOT NULL,
	`synced_at` integer NOT NULL,
	`stale_min_age_days` integer,
	PRIMARY KEY(`server_id`, `key`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- No copy-over: see note above `items`.
DROP TABLE `libraries`;--> statement-breakpoint
ALTER TABLE `__new_libraries` RENAME TO `libraries`;--> statement-breakpoint
ALTER TABLE `settings` ADD `active_server_id` integer REFERENCES servers(id);--> statement-breakpoint
-- sync_log isn't dropped/recreated (its rows aren't identity-scoped data, just history),
-- so old rows survive the ADD COLUMN below with server_id NULL — clear them here rather
-- than leave them invisible to every server-scoped query forever.
DELETE FROM `sync_log`;--> statement-breakpoint
ALTER TABLE `sync_log` ADD `server_id` integer REFERENCES servers(id);