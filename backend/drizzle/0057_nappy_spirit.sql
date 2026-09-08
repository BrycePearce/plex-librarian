CREATE TABLE `service_path_roots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`server_id` integer NOT NULL,
	`service_key` text NOT NULL,
	`configuration_identity` text NOT NULL,
	`service_root` text NOT NULL,
	`storage_root` text NOT NULL,
	`case_sensitive` integer DEFAULT true NOT NULL,
	`has_aliases` integer DEFAULT false NOT NULL,
	`revision` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `service_path_roots_scope` ON `service_path_roots` (`server_id`,`service_key`,`service_root`);