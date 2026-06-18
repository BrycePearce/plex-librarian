PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_libraries` (
	`key` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`type` text NOT NULL,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_libraries`("key", "title", "type", "synced_at") SELECT "key", "title", "type", "synced_at" FROM `libraries`;--> statement-breakpoint
DROP TABLE `libraries`;--> statement-breakpoint
ALTER TABLE `__new_libraries` RENAME TO `libraries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_items` (
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
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`library_key`) REFERENCES `libraries`(`key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_items`("rating_key", "library_key", "title", "type", "added_at", "last_viewed_at", "view_count", "file_size", "duration", "year", "updated_at") SELECT "rating_key", "library_key", "title", "type", "added_at", "last_viewed_at", "view_count", "file_size", "duration", "year", "updated_at" FROM `items`;--> statement-breakpoint
DROP TABLE `items`;--> statement-breakpoint
ALTER TABLE `__new_items` RENAME TO `items`;--> statement-breakpoint
CREATE INDEX `items_last_viewed_at_idx` ON `items` (`last_viewed_at`);--> statement-breakpoint
CREATE INDEX `items_library_key_idx` ON `items` (`library_key`);--> statement-breakpoint
CREATE INDEX `items_library_stale_idx` ON `items` (`library_key`,`last_viewed_at`);