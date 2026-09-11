CREATE TABLE `host_discovery` (
	`server_id` integer PRIMARY KEY NOT NULL,
	`pairing_id` text NOT NULL,
	`daemon_id` text NOT NULL,
	`key_hash` text NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`configuration` text,
	`report_revision` text,
	`scanned_at` integer DEFAULT 0 NOT NULL,
	`checked_at` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT '[]' NOT NULL,
	`reason` text,
	FOREIGN KEY (`server_id`) REFERENCES `servers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `host_discovery_roots` (
	`root_id` integer PRIMARY KEY NOT NULL,
	`evidence_identity` text NOT NULL,
	`checked_at` integer NOT NULL,
	FOREIGN KEY (`root_id`) REFERENCES `service_path_roots`(`id`) ON UPDATE no action ON DELETE cascade
);
