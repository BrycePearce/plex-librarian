CREATE TABLE `missing_audit_scopes` (
	`server_id` integer NOT NULL,
	`instance_id` integer NOT NULL,
	`library_key` text NOT NULL,
	`sync_id` integer NOT NULL,
	`fingerprint` text NOT NULL,
	`attempted_at` integer NOT NULL,
	`completed_at` integer,
	`status` text NOT NULL,
	`reason` text,
	PRIMARY KEY(`server_id`, `instance_id`, `library_key`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`instance_id`) REFERENCES `arr_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `missing_findings` (
	`server_id` integer NOT NULL,
	`instance_id` integer NOT NULL,
	`library_key` text NOT NULL,
	`movie_id` integer NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`evidence` text NOT NULL,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`resolved_at` integer,
	`dismissed` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`server_id`, `instance_id`, `library_key`, `movie_id`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`instance_id`) REFERENCES `arr_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `missing_findings_page` ON `missing_findings` (`server_id`,`resolved_at`,`type`,`instance_id`,`library_key`,`title`,`movie_id`);--> statement-breakpoint
CREATE TABLE `missing_stage_findings` (
	`sync_id` integer NOT NULL,
	`instance_id` integer NOT NULL,
	`library_key` text NOT NULL,
	`movie_id` integer NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`evidence` text NOT NULL,
	PRIMARY KEY(`sync_id`, `instance_id`, `library_key`, `movie_id`)
);
--> statement-breakpoint
CREATE TABLE `missing_stage_keys` (
	`sync_id` integer NOT NULL,
	`library_key` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`rating_key` text NOT NULL,
	PRIMARY KEY(`sync_id`, `library_key`, `kind`, `value`, `rating_key`)
);
--> statement-breakpoint
CREATE TABLE `missing_stage_movies` (
	`sync_id` integer NOT NULL,
	`instance_id` integer NOT NULL,
	`movie_id` integer NOT NULL,
	`evidence` text,
	PRIMARY KEY(`sync_id`, `instance_id`, `movie_id`)
);
--> statement-breakpoint
CREATE TABLE `missing_stage_plex` (
	`sync_id` integer NOT NULL,
	`library_key` text NOT NULL,
	`rating_key` text NOT NULL,
	`evidence` text NOT NULL,
	`complete_paths` integer NOT NULL,
	PRIMARY KEY(`sync_id`, `library_key`, `rating_key`)
);
--> statement-breakpoint
CREATE TABLE `missing_stage_queue` (
	`sync_id` integer NOT NULL,
	`instance_id` integer NOT NULL,
	`queue_id` integer NOT NULL,
	`movie_id` integer NOT NULL,
	PRIMARY KEY(`sync_id`, `instance_id`, `queue_id`)
);
--> statement-breakpoint
CREATE INDEX `missing_queue_movie` ON `missing_stage_queue` (`sync_id`,`instance_id`,`movie_id`);