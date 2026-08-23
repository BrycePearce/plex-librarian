CREATE TEMP TABLE normalized_verified_deletion_operations (
  id text PRIMARY KEY
);--> statement-breakpoint

INSERT INTO normalized_verified_deletion_operations (id)
SELECT DISTINCT operation_id
FROM deletion_targets
WHERE status = 'completed_with_warning'
  AND phase = 'finalizing'
  AND warning = 'The target was removed outside Plex Librarian; the requested safe final state was verified.';--> statement-breakpoint

UPDATE deletion_targets
SET status = 'completed',
    warning = NULL,
    error = NULL
WHERE status = 'completed_with_warning'
  AND phase = 'finalizing'
  AND warning = 'The target was removed outside Plex Librarian; the requested safe final state was verified.';--> statement-breakpoint

UPDATE deletion_operations
SET completed_count = (
      SELECT COUNT(*) FROM deletion_targets
      WHERE operation_id = deletion_operations.id AND status = 'completed'
    ),
    warning_count = (
      SELECT COUNT(*) FROM deletion_targets
      WHERE operation_id = deletion_operations.id AND status = 'completed_with_warning'
    ),
    status = CASE
      WHEN status = 'completed_with_warning' AND NOT EXISTS (
        SELECT 1 FROM deletion_targets
        WHERE operation_id = deletion_operations.id AND status = 'completed_with_warning'
      ) THEN 'completed'
      ELSE status
    END
WHERE id IN (SELECT id FROM normalized_verified_deletion_operations);--> statement-breakpoint

DROP TABLE normalized_verified_deletion_operations;
