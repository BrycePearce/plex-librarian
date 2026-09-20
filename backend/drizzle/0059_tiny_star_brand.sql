CREATE TABLE `historical_download_access` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` integer NOT NULL,
	`arr_instance_id` integer NOT NULL,
	`configuration` text NOT NULL,
	`revision` text NOT NULL,
	`status` text NOT NULL,
	`sample` text,
	`reason` text,
	`checked_at` integer,
	`succeeded_at` integer,
	`problem_revision` text,
	`dismissed_revision` text,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`arr_instance_id`) REFERENCES `arr_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `historical_download_journal` (
	`id` text PRIMARY KEY NOT NULL,
	`operation_id` text NOT NULL,
	`entry` text NOT NULL,
	`evidence` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text,
	`intent_at` integer,
	`finished_at` integer,
	FOREIGN KEY (`operation_id`) REFERENCES `deletion_operations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `historical_download_journal_operation_idx` ON `historical_download_journal` (`operation_id`);--> statement-breakpoint
CREATE TABLE `historical_download_reservations` (
	`entry` text PRIMARY KEY NOT NULL,
	`journal_id` text NOT NULL,
	FOREIGN KEY (`journal_id`) REFERENCES `historical_download_journal`(`id`) ON UPDATE no action ON DELETE no action
);
