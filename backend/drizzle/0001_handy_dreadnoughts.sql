PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_libraries` (
	`id` integer PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`type` text NOT NULL,
	`synced_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_libraries`("id", "key", "title", "type", "synced_at") SELECT "id", "key", "title", "type", "synced_at" FROM `libraries`;--> statement-breakpoint
DROP TABLE `libraries`;--> statement-breakpoint
ALTER TABLE `__new_libraries` RENAME TO `libraries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `libraries_key_unique` ON `libraries` (`key`);--> statement-breakpoint
CREATE INDEX `items_library_stale_idx` ON `items` (`library_key`,`last_viewed_at`);