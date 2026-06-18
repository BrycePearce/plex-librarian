CREATE TABLE `items` (
	`rating_key` text PRIMARY KEY NOT NULL,
	`library_key` text NOT NULL,
	`title` text NOT NULL,
	`type` text NOT NULL,
	`added_at` integer,
	`last_viewed_at` integer,
	`view_count` integer DEFAULT 0,
	`file_size` integer,
	`duration` integer,
	`year` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `items_last_viewed_at_idx` ON `items` (`last_viewed_at`);--> statement-breakpoint
CREATE INDEX `items_library_key_idx` ON `items` (`library_key`);--> statement-breakpoint
CREATE TABLE `libraries` (
	`id` integer PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`type` text NOT NULL,
	`synced_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `libraries_key_unique` ON `libraries` (`key`);--> statement-breakpoint
CREATE TABLE `sync_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`status` text NOT NULL,
	`items_processed` integer DEFAULT 0,
	`error` text
);
