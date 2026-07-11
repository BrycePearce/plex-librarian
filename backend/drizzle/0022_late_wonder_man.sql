ALTER TABLE `users` ADD `last_player` text;--> statement-breakpoint
ALTER TABLE `users` ADD `total_plays` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `total_duration` integer DEFAULT 0 NOT NULL;