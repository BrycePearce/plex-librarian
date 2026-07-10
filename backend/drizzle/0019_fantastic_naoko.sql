CREATE TABLE `episode_media_versions` (
	`server_id` integer NOT NULL,
	`media_id` integer NOT NULL,
	`episode_rating_key` text NOT NULL,
	`season_rating_key` text NOT NULL,
	`show_rating_key` text NOT NULL,
	`library_key` text NOT NULL,
	`episode_title` text NOT NULL,
	`episode_index` integer NOT NULL,
	`season_index` integer NOT NULL,
	`video_resolution` text,
	`bitrate` integer,
	`video_codec` text,
	`container` text,
	`file_size` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `media_id`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`,`season_rating_key`) REFERENCES `seasons`(`server_id`,`rating_key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`,`show_rating_key`) REFERENCES `items`(`server_id`,`rating_key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`,`library_key`) REFERENCES `libraries`(`server_id`,`key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `episode_media_versions_episode_idx` ON `episode_media_versions` (`server_id`,`episode_rating_key`);--> statement-breakpoint
CREATE INDEX `episode_media_versions_library_idx` ON `episode_media_versions` (`server_id`,`library_key`);--> statement-breakpoint
CREATE INDEX `episode_media_versions_show_idx` ON `episode_media_versions` (`server_id`,`show_rating_key`);