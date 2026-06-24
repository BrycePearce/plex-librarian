-- Convert file_size from bytes to kilobytes to avoid 32-bit integer overflow
-- in @db/sqlite for files >= 2 GB. Handles any residual negative values from
-- the 32-bit Plex API before dividing.
UPDATE `items`
SET `file_size` = CASE
  WHEN `file_size` < 0 THEN ROUND((`file_size` + 4294967296) / 1000)
  ELSE ROUND(`file_size` / 1000)
END
WHERE `file_size` IS NOT NULL;
