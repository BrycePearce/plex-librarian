UPDATE `settings`
SET `ip_history_retention_days` = 30
WHERE `ip_history_retention_days` > 0 AND `ip_history_retention_days` < 30;
