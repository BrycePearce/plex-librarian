ALTER TABLE `deletion_targets` ADD `storage_outcome` text;--> statement-breakpoint
ALTER TABLE `deletion_targets` ADD `verified_hardlink_data_size` integer;--> statement-breakpoint
ALTER TABLE `deletion_targets` ADD `verified_file_count` integer;--> statement-breakpoint
ALTER TABLE `deletion_targets` ADD `unknown_file_count` integer;--> statement-breakpoint
ALTER TABLE `deletion_targets` ADD `storage_outcome_reasons` text;--> statement-breakpoint
ALTER TABLE `media_removals` ADD `logical_attributable` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_removals` ADD `verified_hardlink_data_size` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `media_removals` ADD `verified_file_count` integer;--> statement-breakpoint
ALTER TABLE `media_removals` ADD `unknown_file_count` integer;--> statement-breakpoint
ALTER TABLE `media_removals` ADD `storage_outcome` text;
