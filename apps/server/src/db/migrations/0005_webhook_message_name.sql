-- Per-message webhook username override. A webhook message is always authored by
-- the webhook's bot user; this stores the display name the caller supplied for
-- that specific delivery so rendering is consistent across history reloads.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS webhook_name TEXT;
