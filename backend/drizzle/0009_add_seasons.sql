CREATE TABLE `seasons` (
  `rating_key` text PRIMARY KEY NOT NULL,
  `show_rating_key` text NOT NULL REFERENCES `items`(`rating_key`) ON DELETE CASCADE,
  `library_key` text NOT NULL REFERENCES `libraries`(`key`) ON DELETE CASCADE,
  `season_index` integer NOT NULL,
  `title` text NOT NULL,
  `file_size` integer,
  `duration` integer,
  `leaf_count` integer,
  `view_count` integer DEFAULT 0,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `seasons_show_idx` ON `seasons` (`show_rating_key`);
--> statement-breakpoint
CREATE INDEX `seasons_library_idx` ON `seasons` (`library_key`);
--> statement-breakpoint
ALTER TABLE `sync_log` ADD COLUMN `library_key` text;
