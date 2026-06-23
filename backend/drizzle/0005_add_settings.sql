CREATE TABLE `settings` (
  `id` integer PRIMARY KEY NOT NULL,
  `client_id` text NOT NULL,
  `public_jwk` text,
  `private_jwk` text,
  `plex_token` text,
  `plex_token_expires_at` integer,
  `plex_url` text
);