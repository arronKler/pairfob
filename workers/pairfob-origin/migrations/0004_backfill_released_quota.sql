UPDATE daemons
SET quota_released_at = kicked_at
WHERE kicked_at IS NOT NULL AND quota_released_at IS NULL;
