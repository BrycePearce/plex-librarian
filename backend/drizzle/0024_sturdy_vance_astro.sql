CREATE TABLE `user_play_observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`observed_at` integer NOT NULL,
	`event` text NOT NULL,
	`ip` text,
	`player_uuid` text,
	`player_title` text,
	`is_local` integer,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_play_observations_account_observed_idx` ON `user_play_observations` (`server_id`,`account_id`,`observed_at`);--> statement-breakpoint
CREATE INDEX `user_play_observations_observed_at_idx` ON `user_play_observations` (`observed_at`);--> statement-breakpoint
CREATE INDEX `user_play_observations_player_idx` ON `user_play_observations` (`server_id`,`account_id`,`player_uuid`);