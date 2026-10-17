-- Webhooks author their messages as a dedicated bot user so that rendering,
-- mention resolution and audit trails are uniform with human messages.

ALTER TABLE webhooks
  ADD COLUMN IF NOT EXISTS bot_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS webhooks_bot_user_idx ON webhooks (bot_user_id);
