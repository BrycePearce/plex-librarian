ALTER TABLE `deletion_operations` ADD `warning_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `deletion_operations` ADD `removal_confirmed_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `deletion_targets` ADD `phase` text DEFAULT 'validating' NOT NULL;--> statement-breakpoint
ALTER TABLE `deletion_targets` ADD `removal_confirmed_at` integer;--> statement-breakpoint
ALTER TABLE `deletion_targets` ADD `plex_reconciled_at` integer;--> statement-breakpoint
ALTER TABLE `deletion_targets` ADD `plex_attempt_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `deletion_targets` ADD `warning` text;--> statement-breakpoint
UPDATE `deletion_targets`
SET `phase` = 'finalizing',
    `removal_confirmed_at` = `updated_at`,
    `plex_reconciled_at` = `updated_at`
WHERE `status` = 'completed';--> statement-breakpoint
UPDATE `deletion_operations`
SET `completed_count` = (
      SELECT COUNT(*) FROM `deletion_targets`
      WHERE `operation_id` = `deletion_operations`.`id` AND `status` = 'completed'
    ),
    `warning_count` = 0,
    `removal_confirmed_count` = (
      SELECT COUNT(*) FROM `deletion_targets`
      WHERE `operation_id` = `deletion_operations`.`id`
        AND `removal_confirmed_at` IS NOT NULL
    ),
    `failed_count` = (
      SELECT COUNT(*) FROM `deletion_targets`
      WHERE `operation_id` = `deletion_operations`.`id` AND `status` = 'needs_attention'
    ),
    `logical_size_removed` = COALESCE((
      SELECT SUM(`logical_size`) FROM `deletion_targets`
      WHERE `operation_id` = `deletion_operations`.`id`
        AND `removal_confirmed_at` IS NOT NULL
    ), 0);
