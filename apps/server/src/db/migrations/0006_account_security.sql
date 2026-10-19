-- Milestone 1 — account security: change password, email verification,
-- password reset, TOTP two-factor authentication, recovery codes, and
-- short-lived second-factor login challenges.
-- Forward-only migration; preserves existing data.

-- 2FA state on the user. `mfa_secret_enc` holds the AES-256-GCM-encrypted
-- TOTP secret (see apps/server/src/auth/encryption.ts); it stays NULL until a
-- user begins enrollment and mfa_enabled only flips once a code is confirmed.
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret_enc TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enrolled_at TIMESTAMPTZ;

-- Single-use recovery codes for 2FA (stored as SHA-256 hashes).
CREATE TABLE IF NOT EXISTS totp_recovery_codes (
  id          BIGINT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash   TEXT NOT NULL UNIQUE,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS totp_recovery_codes_user_idx ON totp_recovery_codes (user_id) WHERE used_at IS NULL;

-- Short-lived challenges issued after a password-only login for accounts with
-- 2FA enabled. The raw challenge token is returned to the client once; only its
-- SHA-256 is stored. Single-use (used_at) and expiring.
CREATE TABLE IF NOT EXISTS mfa_challenges (
  id          BIGINT PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mfa_challenges_user_idx ON mfa_challenges (user_id) WHERE used_at IS NULL;

-- Speeds up forgot-password lookups ("is this address in use?") and the
-- pending-token sweep during registration/email changes.
CREATE INDEX IF NOT EXISTS email_tokens_user_type_idx ON email_tokens (user_id, type) WHERE used_at IS NULL;

-- Account-scoped security audit trail (the guild audit log only covers
-- guild events). Append-only; records password changes, resets, 2FA
-- transitions, verification events and session revocations.
CREATE TABLE IF NOT EXISTS security_events (
  id         BIGINT PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event      TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS security_events_user_idx ON security_events (user_id, id DESC);
