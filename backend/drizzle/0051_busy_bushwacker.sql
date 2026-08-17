CREATE TABLE `ignored_content` (
	`server_id` integer NOT NULL,
	`rating_key` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `rating_key`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`,`rating_key`) REFERENCES `items`(`server_id`,`rating_key`) ON UPDATE no action ON DELETE cascade
);
