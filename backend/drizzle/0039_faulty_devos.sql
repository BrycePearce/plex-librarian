ALTER TABLE `episode_media_versions` ADD `width` integer;--> statement-breakpoint
ALTER TABLE `episode_media_versions` ADD `height` integer;--> statement-breakpoint
ALTER TABLE `episode_media_versions` ADD `duration` integer;--> statement-breakpoint
ALTER TABLE `episode_media_versions` ADD `video_profile` text;--> statement-breakpoint
ALTER TABLE `episode_media_versions` ADD `video_bit_depth` integer;--> statement-breakpoint
ALTER TABLE `episode_media_versions` ADD `video_dynamic_range` text;--> statement-breakpoint
ALTER TABLE `episode_media_versions` ADD `audio_codec` text;--> statement-breakpoint
ALTER TABLE `episode_media_versions` ADD `audio_channels` integer;--> statement-breakpoint
ALTER TABLE `episode_media_versions` ADD `audio_profile` text;--> statement-breakpoint
ALTER TABLE `episode_media_versions` ADD `audio_streams_json` text;--> statement-breakpoint
ALTER TABLE `episode_media_versions` ADD `subtitle_streams_json` text;--> statement-breakpoint
ALTER TABLE `episode_media_versions` ADD `stream_details_available` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `item_media_versions` ADD `width` integer;--> statement-breakpoint
ALTER TABLE `item_media_versions` ADD `height` integer;--> statement-breakpoint
ALTER TABLE `item_media_versions` ADD `duration` integer;--> statement-breakpoint
ALTER TABLE `item_media_versions` ADD `video_profile` text;--> statement-breakpoint
ALTER TABLE `item_media_versions` ADD `video_bit_depth` integer;--> statement-breakpoint
ALTER TABLE `item_media_versions` ADD `video_dynamic_range` text;--> statement-breakpoint
ALTER TABLE `item_media_versions` ADD `audio_codec` text;--> statement-breakpoint
ALTER TABLE `item_media_versions` ADD `audio_channels` integer;--> statement-breakpoint
ALTER TABLE `item_media_versions` ADD `audio_profile` text;--> statement-breakpoint
ALTER TABLE `item_media_versions` ADD `audio_streams_json` text;--> statement-breakpoint
ALTER TABLE `item_media_versions` ADD `subtitle_streams_json` text;--> statement-breakpoint
ALTER TABLE `item_media_versions` ADD `stream_details_available` integer DEFAULT false NOT NULL;