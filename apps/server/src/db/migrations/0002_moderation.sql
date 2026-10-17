-- Guild bans and a durable per-user rate-limit/anti-spam ledger.

CREATE TABLE IF NOT EXISTS guild_bans (
  guild_id      BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  moderator_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS guild_bans_user_idx ON guild_bans (user_id);
