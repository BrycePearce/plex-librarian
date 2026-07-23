UPDATE `servers` SET `users_synced_at` = NULL;
--> statement-breakpoint
UPDATE `users`
SET
	`local_account_id` = NULL,
	`last_viewed_at` = NULL,
	`last_ip` = NULL,
	`last_player` = NULL,
	`total_plays` = 0,
	`total_duration` = 0,
	`last_scrobbled_at` = NULL;
--> statement-breakpoint
DELETE FROM `user_item_activity`;
--> statement-breakpoint
DELETE FROM `user_season_activity`;
--> statement-breakpoint
DELETE FROM `user_ip_history`;
--> statement-breakpoint
DELETE FROM `user_play_observations`;
