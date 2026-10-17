-- Nebula initial schema.
-- Conventions:
--   * All snowflake ids are BIGINT (numeric ordering == chronological ordering).
--     node-postgres returns BIGINT/NUMERIC as strings, which we treat as opaque ids.
--   * Permission bitfields are BIGINT (max used bit is 52, well within 64-bit range).
--   * Timestamps are timestamptz.
--   * Deletion policies are explicit and chosen per relationship.

CREATE TABLE IF NOT EXISTS schema_migrations (
  name        TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Users, credentials, sessions
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS users (
  id                BIGINT PRIMARY KEY,
  username          TEXT NOT NULL,
  username_lower    TEXT NOT NULL,
  discriminator     TEXT NOT NULL,
  display_name      TEXT,
  email             TEXT,
  email_verified    BOOLEAN NOT NULL DEFAULT FALSE,
  password_hash     TEXT NOT NULL,
  password_salt     TEXT NOT NULL,
  password_params   TEXT NOT NULL DEFAULT 'scrypt:N=32768,r=8,p=1',
  avatar_key        TEXT,
  banner_key        TEXT,
  accent_color      INTEGER,
  bio               TEXT,
  bot               BOOLEAN NOT NULL DEFAULT FALSE,
  system            BOOLEAN NOT NULL DEFAULT FALSE,
  premium_type      SMALLINT NOT NULL DEFAULT 0,
  flags             BIGINT NOT NULL DEFAULT 0,
  disabled          BOOLEAN NOT NULL DEFAULT FALSE,
  disabled_reason   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_key ON users (username_lower);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (lower(email)) WHERE email IS NOT NULL;

CREATE TABLE IF NOT EXISTS user_settings (
  user_id                 BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  theme                   TEXT NOT NULL DEFAULT 'dark',
  message_display         TEXT NOT NULL DEFAULT 'cozy',
  reduced_motion          BOOLEAN NOT NULL DEFAULT FALSE,
  font_scale              REAL NOT NULL DEFAULT 1.0,
  locale                  TEXT NOT NULL DEFAULT 'en-US',
  notification_desktop    BOOLEAN NOT NULL DEFAULT TRUE,
  notification_sounds     BOOLEAN NOT NULL DEFAULT TRUE,
  suppress_everyone       BOOLEAN NOT NULL DEFAULT FALSE,
  suppress_roles          BOOLEAN NOT NULL DEFAULT FALSE,
  suppress_from_others    BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id           BIGINT PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  csrf_secret  TEXT NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  client_name  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS email_tokens (
  id          BIGINT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,        -- 'verify_email' | 'reset_password'
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Relationships (friends / blocks / requests)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS relationships (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       SMALLINT NOT NULL,     -- 1 friend, 2 blocked, 3 incoming, 4 outgoing
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, target_id),
  CHECK (user_id <> target_id)
);
CREATE INDEX IF NOT EXISTS relationships_target_idx ON relationships (target_id, type);

-- ---------------------------------------------------------------------------
-- Guilds, members, roles, invites
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS guilds (
  id                 BIGINT PRIMARY KEY,
  name               TEXT NOT NULL,
  icon_key           TEXT,
  owner_id           BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  description        TEXT,
  system_channel_id  BIGINT,
  rules_channel_id   BIGINT,
  features           TEXT[] NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guild_members (
  guild_id      BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname      TEXT,
  joined_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  timeout_until TIMESTAMPTZ,
  is_owner      BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (guild_id, user_id)
);
CREATE INDEX IF NOT EXISTS guild_members_user_idx ON guild_members (user_id);

CREATE TABLE IF NOT EXISTS roles (
  id           BIGINT PRIMARY KEY,
  guild_id     BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  color        INTEGER NOT NULL DEFAULT 0,
  hoist        BOOLEAN NOT NULL DEFAULT FALSE,
  position     INTEGER NOT NULL DEFAULT 0,
  permissions  BIGINT NOT NULL DEFAULT 0,
  managed      BOOLEAN NOT NULL DEFAULT FALSE,
  mentionable  BOOLEAN NOT NULL DEFAULT FALSE,
  is_everyone  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS roles_guild_idx ON roles (guild_id, position DESC);
-- Exactly one @everyone role per guild.
CREATE UNIQUE INDEX IF NOT EXISTS roles_guild_everyone_key ON roles (guild_id) WHERE is_everyone;

CREATE TABLE IF NOT EXISTS member_roles (
  guild_id BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  user_id  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id  BIGINT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (guild_id, user_id, role_id)
);

-- NOTE: `channel_id` FK is added after `channels` exists (see below).
CREATE TABLE IF NOT EXISTS invites (
  code       TEXT PRIMARY KEY,
  guild_id   BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id BIGINT NOT NULL,
  inviter_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  uses       INTEGER NOT NULL DEFAULT 0,
  max_uses   INTEGER NOT NULL DEFAULT 0,
  max_age    INTEGER NOT NULL DEFAULT 86400,
  temporary  BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  revoked    BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS invites_guild_idx ON invites (guild_id);

-- ---------------------------------------------------------------------------
-- Channels, overwrites, threads
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS channels (
  id                            BIGINT PRIMARY KEY,
  guild_id                      BIGINT REFERENCES guilds(id) ON DELETE CASCADE,
  type                          SMALLINT NOT NULL,
  name                          TEXT,
  topic                         TEXT,
  position                      INTEGER NOT NULL DEFAULT 0,
  parent_id                     BIGINT REFERENCES channels(id) ON DELETE SET NULL,
  nsfw                          BOOLEAN NOT NULL DEFAULT FALSE,
  rate_limit_per_user           INTEGER NOT NULL DEFAULT 0,
  user_limit                    INTEGER NOT NULL DEFAULT 0,
  bitrate                       INTEGER NOT NULL DEFAULT 64000,
  last_message_id               BIGINT,
  owner_id                      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  icon_key                      TEXT,
  default_auto_archive_duration INTEGER NOT NULL DEFAULT 1440,
  flags                         INTEGER NOT NULL DEFAULT 0,
  -- thread-specific
  thread_archived               BOOLEAN NOT NULL DEFAULT FALSE,
  thread_archive_timestamp      TIMESTAMPTZ,
  thread_locked                 BOOLEAN NOT NULL DEFAULT FALSE,
  thread_message_count          INTEGER NOT NULL DEFAULT 0,
  thread_total_messages         INTEGER NOT NULL DEFAULT 0,
  -- DM-specific
  dm_closed                     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS channels_guild_idx ON channels (guild_id, position);
CREATE INDEX IF NOT EXISTS channels_parent_idx ON channels (parent_id);
CREATE INDEX IF NOT EXISTS channels_threads_idx ON channels (parent_id, type) WHERE type IN (11, 12);

-- Deferred FK: `invites` was declared before `channels` existed.
ALTER TABLE invites
  ADD CONSTRAINT invites_channel_id_fkey
  FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE;

CREATE TABLE IF NOT EXISTS channel_overwrites (
  channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_id  BIGINT NOT NULL,
  type       SMALLINT NOT NULL,           -- 0 role, 1 member
  allow      BIGINT NOT NULL DEFAULT 0,
  deny       BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (channel_id, target_id),
  CHECK (type IN (0, 1))
);

CREATE TABLE IF NOT EXISTS dm_recipients (
  channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS dm_recipients_user_idx ON dm_recipients (user_id);

CREATE TABLE IF NOT EXISTS thread_members (
  thread_id      BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  join_timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),
  flags          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (thread_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Messages, mentions, attachments, reactions, pins
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS messages (
  id                  BIGINT PRIMARY KEY,
  channel_id          BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  guild_id            BIGINT REFERENCES guilds(id) ON DELETE CASCADE,
  author_id           BIGINT REFERENCES users(id) ON DELETE SET NULL,
  content             TEXT NOT NULL DEFAULT '',
  tts                 BOOLEAN NOT NULL DEFAULT FALSE,
  mention_everyone    BOOLEAN NOT NULL DEFAULT FALSE,
  mention_role_ids    BIGINT[] NOT NULL DEFAULT '{}',
  flags               INTEGER NOT NULL DEFAULT 0,
  type                SMALLINT NOT NULL DEFAULT 0,
  pinned              BOOLEAN NOT NULL DEFAULT FALSE,
  reference_message_id BIGINT,
  reference_channel_id BIGINT,
  reference_type      SMALLINT,
  webhook_id          BIGINT,
  application_id      BIGINT,
  nonce               TEXT,
  edited_at           TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ
);
-- Keyset pagination + history scans are by (channel_id, id DESC).
CREATE INDEX IF NOT EXISTS messages_channel_id_idx ON messages (channel_id, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS messages_author_idx ON messages (author_id, id DESC) WHERE deleted_at IS NULL;
-- Full-text search over message content.
CREATE INDEX IF NOT EXISTS messages_content_fts_idx
  ON messages USING GIN (to_tsvector('simple', content)) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS message_mentions (
  message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX IF NOT EXISTS message_mentions_user_idx ON message_mentions (user_id);

CREATE TABLE IF NOT EXISTS attachments (
  id           BIGINT PRIMARY KEY,
  message_id   BIGINT REFERENCES messages(id) ON DELETE CASCADE,
  uploader_id  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  channel_id   BIGINT REFERENCES channels(id) ON DELETE CASCADE,
  guild_id     BIGINT REFERENCES guilds(id) ON DELETE CASCADE,
  filename     TEXT NOT NULL,
  content_type TEXT,
  size_bytes   BIGINT NOT NULL,
  width        INTEGER,
  height       INTEGER,
  storage_key  TEXT NOT NULL,
  checksum     TEXT,
  is_spoiler   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attachments_message_idx ON attachments (message_id);
CREATE INDEX IF NOT EXISTS attachments_guild_idx ON attachments (guild_id) WHERE guild_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS reactions (
  message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji      TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS reactions_message_idx ON reactions (message_id);

CREATE TABLE IF NOT EXISTS pins (
  channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message_id BIGINT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  pinned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, message_id)
);

-- ---------------------------------------------------------------------------
-- Read state, notifications, presence
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS read_states (
  user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id          BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_message_id BIGINT,
  mention_count       INTEGER NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, channel_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id         BIGINT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  actor_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  guild_id   BIGINT REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id BIGINT REFERENCES channels(id) ON DELETE CASCADE,
  message_id BIGINT,
  title      TEXT NOT NULL,
  body       TEXT,
  read       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS voice_states (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  guild_id    BIGINT REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id  BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  session_id  TEXT NOT NULL,
  self_mute   BOOLEAN NOT NULL DEFAULT FALSE,
  self_deaf   BOOLEAN NOT NULL DEFAULT FALSE,
  self_stream BOOLEAN NOT NULL DEFAULT FALSE,
  self_video  BOOLEAN NOT NULL DEFAULT FALSE,
  mute        BOOLEAN NOT NULL DEFAULT FALSE,
  deaf        BOOLEAN NOT NULL DEFAULT FALSE,
  suppress    BOOLEAN NOT NULL DEFAULT FALSE,
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS voice_states_channel_idx ON voice_states (channel_id);

CREATE TABLE IF NOT EXISTS presence (
  user_id       BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'offline',
  custom_status TEXT,
  activities    JSONB NOT NULL DEFAULT '[]',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Moderation, audit log, reports
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS audit_log_entries (
  id          BIGINT PRIMARY KEY,
  guild_id    BIGINT NOT NULL REFERENCES guilds(id) ON DELETE CASCADE,
  action_type SMALLINT NOT NULL,
  actor_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  target_id   BIGINT,
  reason      TEXT,
  changes     JSONB NOT NULL DEFAULT '[]',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_guild_idx ON audit_log_entries (guild_id, id DESC);

CREATE TABLE IF NOT EXISTS reports (
  id             BIGINT PRIMARY KEY,
  reporter_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  target_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  guild_id       BIGINT REFERENCES guilds(id) ON DELETE CASCADE,
  message_id     BIGINT,
  category       TEXT NOT NULL,
  reason         TEXT,
  status         TEXT NOT NULL DEFAULT 'open',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Integrations: applications, slash commands, webhooks
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS applications (
  id          BIGINT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  owner_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  bot_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS slash_commands (
  id             BIGINT PRIMARY KEY,
  application_id BIGINT REFERENCES applications(id) ON DELETE CASCADE,
  guild_id       BIGINT REFERENCES guilds(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL,
  options        JSONB NOT NULL DEFAULT '[]',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS slash_commands_global_key
  ON slash_commands (application_id, name) WHERE guild_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS slash_commands_guild_key
  ON slash_commands (application_id, guild_id, name) WHERE guild_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS webhooks (
  id           BIGINT PRIMARY KEY,
  guild_id     BIGINT REFERENCES guilds(id) ON DELETE CASCADE,
  channel_id   BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  avatar_key   TEXT,
  creator_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS webhooks_channel_idx ON webhooks (channel_id);

-- Storage accounting per guild (kept transactional to avoid TOCTOU on quota).
CREATE TABLE IF NOT EXISTS guild_storage (
  guild_id   BIGINT PRIMARY KEY REFERENCES guilds(id) ON DELETE CASCADE,
  used_bytes BIGINT NOT NULL DEFAULT 0
);
