CREATE TABLE `item_media_versions` (
	`server_id` integer NOT NULL,
	`media_id` integer NOT NULL,
	`item_rating_key` text NOT NULL,
	`library_key` text NOT NULL,
	`video_resolution` text,
	`bitrate` integer,
	`video_codec` text,
	`container` text,
	`file_size` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `media_id`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`,`item_rating_key`) REFERENCES `items`(`server_id`,`rating_key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`,`library_key`) REFERENCES `libraries`(`server_id`,`key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `item_media_versions_item_idx` ON `item_media_versions` (`server_id`,`item_rating_key`);--> statement-breakpoint
CREATE INDEX `item_media_versions_library_idx` ON `item_media_versions` (`server_id`,`library_key`);