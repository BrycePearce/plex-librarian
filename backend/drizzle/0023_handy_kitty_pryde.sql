ALTER TABLE `users` ADD `shared_server_id` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `last_scrobbled_at` integer;--> statement-breakpoint
ALTER TABLE `settings` ADD `ip_history_retention_days` integer DEFAULT 365 NOT NULL;--> statement-breakpoint
CREATE INDEX `user_ip_history_last_seen_idx` ON `user_ip_history` (`last_seen_at`);
