ALTER TABLE `items` ADD `season_first_index` integer;--> statement-breakpoint
ALTER TABLE `items` ADD `season_last_index` integer;--> statement-breakpoint
ALTER TABLE `items` ADD `season_present_count` integer;--> statement-breakpoint
ALTER TABLE `items` ADD `season_gap_count` integer;--> statement-breakpoint
ALTER TABLE `items` ADD `season_gap_ranges_json` text;--> statement-breakpoint
ALTER TABLE `items` ADD `season_audit_status` text;--> statement-breakpoint
ALTER TABLE `items` ADD `season_audit_reason` text;--> statement-breakpoint
CREATE INDEX `items_season_gaps_idx` ON `items` (`server_id`,`season_gap_count`) WHERE "items"."season_audit_status" = 'gaps';--> statement-breakpoint
CREATE INDEX `items_season_gaps_library_idx` ON `items` (`server_id`,`library_key`,`season_gap_count`) WHERE "items"."season_audit_status" = 'gaps';--> statement-breakpoint
UPDATE `libraries` SET `episode_audit_synced_at` = NULL WHERE `type` = 'show';
