CREATE TABLE `seerr_request_seasons` (
	`seerr_instance_id` integer NOT NULL,
	`request_id` integer NOT NULL,
	`season_number` integer NOT NULL,
	PRIMARY KEY(`seerr_instance_id`, `request_id`, `season_number`),
	FOREIGN KEY (`seerr_instance_id`,`request_id`) REFERENCES `seerr_requests`(`seerr_instance_id`,`request_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_season_activity` (
	`server_id` integer NOT NULL,
	`account_id` integer NOT NULL,
	`show_rating_key` text NOT NULL,
	`season_number` integer NOT NULL,
	`first_viewed_at` integer NOT NULL,
	`last_viewed_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `account_id`, `show_rating_key`, `season_number`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_season_activity_account_show_idx` ON `user_season_activity` (`server_id`,`account_id`,`show_rating_key`);--> statement-breakpoint
CREATE TABLE `seerr_request_sync_stage` (
	`seerr_instance_id` integer NOT NULL,
	`sync_marker` integer NOT NULL,
	`request_id` integer NOT NULL,
	`server_id` integer NOT NULL,
	`account_id` integer,
	`requester_username` text,
	`requester_email` text,
	`rating_key` text,
	`media_type` text,
	`request_status` integer NOT NULL,
	`media_status` integer NOT NULL,
	`requested_at` integer NOT NULL,
	`available_at` integer,
	`availability_observed_at` integer,
	`availability_observed_sync_at` integer,
	`availability_estimated` integer NOT NULL,
	PRIMARY KEY(`seerr_instance_id`, `sync_marker`, `request_id`),
	FOREIGN KEY (`seerr_instance_id`) REFERENCES `seerr_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `seerr_request_season_sync_stage` (
	`seerr_instance_id` integer NOT NULL,
	`sync_marker` integer NOT NULL,
	`request_id` integer NOT NULL,
	`season_number` integer NOT NULL,
	PRIMARY KEY(`seerr_instance_id`, `sync_marker`, `request_id`, `season_number`),
	FOREIGN KEY (`seerr_instance_id`,`sync_marker`,`request_id`) REFERENCES `seerr_request_sync_stage`(`seerr_instance_id`,`sync_marker`,`request_id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `seerr_requests` ADD `media_type` text;--> statement-breakpoint
ALTER TABLE `seerr_requests` ADD `availability_observed_at` integer;--> statement-breakpoint
ALTER TABLE `seerr_requests` ADD `availability_observed_sync_at` integer;--> statement-breakpoint
UPDATE `seerr_requests`
SET `availability_observed_at` = `available_at`,
	`availability_observed_sync_at` = `synced_at`,
	`available_at` = NULL
WHERE `available_at` IS NOT NULL;
--> statement-breakpoint
UPDATE `seerr_requests`
SET `media_type` = (
	SELECT CASE
		WHEN `items`.`type` = 'movie' THEN 'movie'
		WHEN `items`.`type` = 'show' THEN 'tv'
	END
	FROM `items`
	WHERE `items`.`server_id` = `seerr_requests`.`server_id`
		AND `items`.`rating_key` = `seerr_requests`.`rating_key`
)
WHERE `rating_key` IS NOT NULL;
--> statement-breakpoint
UPDATE `seerr_instances` SET `requests_synced_at` = NULL;
--> statement-breakpoint
UPDATE `libraries` SET `history_synced_at` = NULL WHERE `type` IN ('movie', 'show');
