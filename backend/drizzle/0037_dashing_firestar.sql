CREATE TABLE `deletion_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`client_request_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`server_id` integer NOT NULL,
	`library_key` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`target_count` integer NOT NULL,
	`completed_count` integer DEFAULT 0 NOT NULL,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`logical_size_removed` integer DEFAULT 0 NOT NULL,
	`next_retry_at` integer,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`,`library_key`) REFERENCES `libraries`(`server_id`,`key`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deletion_operations_request_unique` ON `deletion_operations` (`server_id`,`client_request_id`);--> statement-breakpoint
CREATE INDEX `deletion_operations_work_idx` ON `deletion_operations` (`status`,`next_retry_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `deletion_targets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`operation_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`target_kind` text NOT NULL,
	`target_key` text NOT NULL,
	`title` text NOT NULL,
	`snapshot` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_retry_at` integer,
	`error` text,
	`logical_size` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `deletion_operations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deletion_targets_operation_ordinal_unique` ON `deletion_targets` (`operation_id`,`ordinal`);--> statement-breakpoint
CREATE INDEX `deletion_targets_work_idx` ON `deletion_targets` (`status`,`next_retry_at`,`operation_id`,`ordinal`);--> statement-breakpoint
CREATE TABLE `media_version_reservations` (
	`server_id` integer NOT NULL,
	`media_kind` text NOT NULL,
	`media_id` integer NOT NULL,
	`rating_key` text NOT NULL,
	`operation_id` text NOT NULL,
	`target_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `media_kind`, `media_id`),
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`operation_id`) REFERENCES `deletion_operations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `deletion_targets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `media_version_reservations_rating_idx` ON `media_version_reservations` (`server_id`,`media_kind`,`rating_key`);
