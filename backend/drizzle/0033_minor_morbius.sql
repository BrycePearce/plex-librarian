ALTER TABLE `user_play_observations` ADD `source` text DEFAULT 'webhook' NOT NULL;--> statement-breakpoint
ALTER TABLE `user_play_observations` ADD `session_key` text;--> statement-breakpoint
ALTER TABLE `user_play_observations` ADD `rating_key` text;--> statement-breakpoint
CREATE INDEX `user_play_observations_session_idx` ON `user_play_observations` (`server_id`,`session_key`,`observed_at`);