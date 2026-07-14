CREATE TABLE `arr_delete_attempts` (
	`server_id` integer NOT NULL,
	`rating_key` text NOT NULL,
	`library_key` text NOT NULL,
	`arr_instance_id` integer NOT NULL,
	`external_id` integer NOT NULL,
	`started_at` integer NOT NULL,
	PRIMARY KEY(`server_id`, `rating_key`, `arr_instance_id`),
	FOREIGN KEY (`server_id`,`rating_key`) REFERENCES `items`(`server_id`,`rating_key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`server_id`,`library_key`) REFERENCES `libraries`(`server_id`,`key`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`arr_instance_id`) REFERENCES `arr_instances`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TEMP TABLE `_arr_instance_keepers` AS
SELECT `server_id`, `type`, `url`, MAX(`id`) AS `keeper_id`
FROM `arr_instances`
GROUP BY `server_id`, `type`, `url`;--> statement-breakpoint
INSERT INTO `arr_library_mappings`
  (`server_id`, `library_key`, `arr_instance_id`, `add_import_exclusion`)
SELECT m.`server_id`, m.`library_key`, k.`keeper_id`, m.`add_import_exclusion`
FROM `arr_library_mappings` m
INNER JOIN `arr_instances` i ON i.`id` = m.`arr_instance_id`
INNER JOIN `_arr_instance_keepers` k
  ON k.`server_id` = i.`server_id` AND k.`type` = i.`type` AND k.`url` = i.`url`
WHERE m.`arr_instance_id` <> k.`keeper_id`
ON CONFLICT (`server_id`, `library_key`, `arr_instance_id`) DO UPDATE SET
  `add_import_exclusion` = MAX(
    `arr_library_mappings`.`add_import_exclusion`,
    excluded.`add_import_exclusion`
  );--> statement-breakpoint
DELETE FROM `arr_instances`
WHERE `id` NOT IN (SELECT `keeper_id` FROM `_arr_instance_keepers`);--> statement-breakpoint
DROP TABLE `_arr_instance_keepers`;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `arr_instances_server_type_url_unique` ON `arr_instances` (`server_id`,`type`,`url`);--> statement-breakpoint
CREATE INDEX `items_server_tmdb_id_idx` ON `items` (`server_id`,`tmdb_id`) WHERE "items"."tmdb_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `items_server_tvdb_id_idx` ON `items` (`server_id`,`tvdb_id`) WHERE "items"."tvdb_id" IS NOT NULL;
