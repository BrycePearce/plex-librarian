ALTER TABLE `libraries` ADD `episode_audit_synced_at` integer;--> statement-breakpoint
ALTER TABLE `seasons` ADD `episode_first_index` integer;--> statement-breakpoint
ALTER TABLE `seasons` ADD `episode_last_index` integer;--> statement-breakpoint
ALTER TABLE `seasons` ADD `episode_present_count` integer;--> statement-breakpoint
ALTER TABLE `seasons` ADD `episode_gap_count` integer;--> statement-breakpoint
ALTER TABLE `seasons` ADD `episode_gap_ranges_json` text;--> statement-breakpoint
ALTER TABLE `seasons` ADD `episode_audit_status` text;--> statement-breakpoint
ALTER TABLE `seasons` ADD `episode_audit_reason` text;--> statement-breakpoint
CREATE INDEX `seasons_episode_gaps_idx` ON `seasons` (`server_id`,`episode_gap_count`) WHERE "seasons"."episode_audit_status" = 'gaps';--> statement-breakpoint
CREATE INDEX `seasons_episode_gaps_library_idx` ON `seasons` (`server_id`,`library_key`,`episode_gap_count`) WHERE "seasons"."episode_audit_status" = 'gaps';
