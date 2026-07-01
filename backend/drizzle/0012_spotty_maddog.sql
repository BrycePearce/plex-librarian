ALTER TABLE `libraries` ADD `stale_min_age_days` integer;
ALTER TABLE `settings` ADD `stale_min_age_days` integer DEFAULT 90 NOT NULL;
