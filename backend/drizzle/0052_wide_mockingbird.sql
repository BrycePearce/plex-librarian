ALTER TABLE `seasons` ADD `added_at` integer;--> statement-breakpoint
ALTER TABLE `seasons` ADD `last_viewed_at` integer;--> statement-breakpoint
CREATE INDEX `seasons_library_stale_idx` ON `seasons` (`server_id`,`library_key`,`last_viewed_at`);--> statement-breakpoint
CREATE INDEX `seasons_library_file_size_idx` ON `seasons` (`server_id`,`library_key`,`file_size`);--> statement-breakpoint
UPDATE `libraries` SET `history_synced_at` = NULL WHERE `type` = 'show';
