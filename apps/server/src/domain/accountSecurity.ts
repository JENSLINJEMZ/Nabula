import { createHash, randomBytes, randomInt } from "node:crypto";
import { Errors, Limits, validatePassword } from "@nebula/shared";
import { APP_URL } from "../config.js";
import { nextId } from "../ids.js";
import { execute, query, queryOne, withTransaction } from "../db/pool.js";
import { decryptSecret, encryptSecret } from "../auth/encryption.js";
import { hashPassword, verifyPassword } from "../auth/passwords.js";
import {
  generateQrCodeDataUrl,
  generateTotpSecret,
  getTotpUri,
  verifyTotpCode,
} from "../auth/totp.js";
import {
  MailNotConfiguredError,
  passwordResetEmail,
  sendEmail,
  verificationEmail,
} from "../mail/mailer.js";
import { disconnectUserSessions } from "../realtime/sessionSockets.js";
import { logger } from "../logger.js";

/**
 * Account-security domain: change password, email verification, password
 * reset, TOTP two-factor authentication with recovery codes, and the
 * short-lived second-factor challenges used at login.
 *
 * Token hygiene everywhere: raw tokens are random 32-byte values returned to
 * the client (or emailed) exactly once; only their SHA-256 is persisted.
 * Tokens are single-use (`used_at`) and expiring; consumption is a conditional
 * UPDATE so a token can never be redeemed twice, even concurrently.
 */

export const TOKEN_TTL = {
  verify_email: 24 * 60 * 60, // 24 hours
  reset_password: 60 * 60, // 1 hour
} as const;

export type EmailTokenType = keyof typeof TOKEN_TTL;

export const MFA_CHALLENGE_TTL_SECONDS = 300;
export const RECOVERY_CODE_COUNT = 10;

// ---------------------------------------------------------------------------
// Security event log (account-scoped audit trail)
// ---------------------------------------------------------------------------

export interface SecurityEventMeta {
  ip?: string | null;
  userAgent?: string | null;
}

export type SecurityEvent =
  | "password_changed"
  | "password_reset_requested"
  | "password_reset_completed"
  | "email_verification_sent"
  | "email_verified"
  | "mfa_enrollment_started"
  | "mfa_enabled"
  | "mfa_disabled"
  | "mfa_login_succeeded"
  | "mfa_recovery_code_used"
  | "sessions_revoked";

export async function writeSecurityEvent(
  userId: string,
  event: SecurityEvent,
  meta: SecurityEventMeta = {},
): Promise<void> {
  await execute(
    `INSERT INTO security_events (id, user_id, event, ip, user_agent) VALUES ($1, $2, $3, $4, $5)`,
    [nextId(), userId, event, meta.ip ?? null, meta.userAgent ?? null],
  ).catch((error) => {
    // The audit trail must never break the primary action.
    logger.warn("security event write failed", {
      userId,
      event,
      error: error instanceof Error ? error.message : String(error),
    });
  });
}

// ---------------------------------------------------------------------------
// Password verification helper
// ---------------------------------------------------------------------------

interface CredentialRow {
  password_hash: string;
  password_salt: string;
  password_params: string;
}

async function getCredentialsById(userId: string): Promise<CredentialRow | null> {
  return queryOne<CredentialRow>(
    `SELECT password_hash, password_salt, password_params FROM users WHERE id = $1`,
    [userId],
  );
}

/** Verify the supplied password for a user; constant-false for unknown users. */
async function verifyUserPassword(userId: string, password: string): Promise<boolean> {
  const row = await getCredentialsById(userId);
  if (!row) return false;
  return verifyPassword(password, { hash: row.password_hash, salt: row.password_salt });
}

async function setpasswordHash(userId: string, hash: string, salt: string, params: string): Promise<void> {
  await execute(
    `UPDATE users SET password_hash = $2, password_salt = $3, password_params = $4, updated_at = now()
      WHERE id = $1`,
    [userId, hash, salt, params],
  );
}

// ---------------------------------------------------------------------------
// Change password
// ---------------------------------------------------------------------------

export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  keepSessionId: string,
  meta: SecurityEventMeta = {},
): Promise<{ revokedSessions: number }> {
  const check = validatePassword(newPassword);
  if (!check.ok) throw Errors.VALIDATION_FAILED({ field: "newPassword" }, check.reason);

  // Generic message: never reveal whether the account exists or which field
  // was wrong to an unauthenticated caller — here the caller is authenticated,
  // but the current password must still be verified before any change.
  const ok = await verifyUserPassword(userId, currentPassword);
  if (!ok) throw Errors.INVALID_CREDENTIALS(undefined, "Your current password is not correct.");

  const hashed = await hashPassword(newPassword);
  await setpasswordHash(userId, hashed.hash, hashed.salt, hashed.params);

  // Policy: a password change revokes every other session; the session that
  // performed the change stays valid so the user is not logged out of the
  // device they are using.
  const revokedSessions = await revokeOtherSessions(userId, keepSessionId);
  await writeSecurityEvent(userId, "password_changed", meta);
  if (revokedSessions > 0) {
    await writeSecurityEvent(userId, "sessions_revoked", { ...meta, ip: meta.ip ?? null });
  }
  return { revokedSessions };
}

// ---------------------------------------------------------------------------
// Email tokens (verification + password reset)
// ---------------------------------------------------------------------------

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Issue a single-use email token of the requested type. Any previously issued,
 * unused token of the same type is invalidated so only the newest link works.
 */
export async function issueEmailToken(userId: string, type: EmailTokenType): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  const ttl = TOKEN_TTL[type];
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE email_tokens SET used_at = now()
        WHERE user_id = $1 AND type = $2 AND used_at IS NULL`,
      [userId, type],
    );
    await tx.query(
      `INSERT INTO email_tokens (id, user_id, type, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
      [nextId(), userId, type, hashToken(token), ttl],
    );
  });
  return token;
}

/**
 * Atomically consume a token. Returns the owning user id when the token
 * exists, is of the requested type, is unexpired and unused — otherwise null.
 * The conditional UPDATE guarantees single use even under concurrent requests.
 */
export async function consumeEmailToken(token: string, type: EmailTokenType): Promise<string | null> {
  if (!token || token.length > 256) return null;
  const rows = await query<{ user_id: string }>(
    `UPDATE email_tokens
        SET used_at = now()
      WHERE token_hash = $1
        AND type = $2
        AND used_at IS NULL
        AND expires_at > now()
      RETURNING user_id`,
    [hashToken(token), type],
  );
  return rows[0]?.user_id ?? null;
}

// ---------------------------------------------------------------------------
// Email verification
// ---------------------------------------------------------------------------

/**
 * Send a verification email for the user's current address. The caller must
 * have checked that the account has an email on file.
 */
export async function sendVerificationEmail(
  userId: string,
  email: string,
  meta: SecurityEventMeta = {},
): Promise<void> {
  const token = await issueEmailToken(userId, "verify_email");
  await sendEmail(verificationEmail(email, token, APP_URL));
  await writeSecurityEvent(userId, "email_verification_sent", meta);
}

export async function verifyEmailWithToken(token: string, meta: SecurityEventMeta = {}): Promise<string> {
  const userId = await consumeEmailToken(token, "verify_email");
  if (!userId) throw Errors.TOKEN_INVALID();
  await execute(`UPDATE users SET email_verified = TRUE, updated_at = now() WHERE id = $1`, [userId]);
  await writeSecurityEvent(userId, "email_verified", meta);
  return userId;
}

// ---------------------------------------------------------------------------
// Password reset
// ---------------------------------------------------------------------------

/**
 * Start the forgot-password flow. Always resolves without revealing whether
 * the address has an account (anti-enumeration): the token is only issued and
 * emailed when the address matches an active account with an email on file.
 * Throws MAIL_NOT_CONFIGURED when the server cannot actually send email,
 * because pretending to send would lock the user out silently.
 */
export async function requestPasswordReset(email: string, meta: SecurityEventMeta = {}): Promise<void> {
  const normalized = email.trim().toLowerCase();
  const row = await queryOne<{ id: string }>(
    `SELECT id FROM users WHERE LOWER(email) = $1 AND disabled = FALSE`,
    [normalized],
  );
  if (!row) {
    logger.info("password reset requested for unknown address", {});
    return; // generic no-op; caller answers 202 either way
  }
  const token = await issueEmailToken(row.id, "reset_password");
  try {
    await sendEmail(passwordResetEmail(normalized, token, APP_URL));
  } catch (error) {
    if (error instanceof MailNotConfiguredError) {
      // Roll the token back so it cannot linger unusable-but-valid.
      await execute(`UPDATE email_tokens SET used_at = now() WHERE token_hash = $1`, [hashToken(token)]);
      throw error;
    }
    throw error;
  }
  await writeSecurityEvent(row.id, "password_reset_requested", meta);
}

/**
 * Complete a password reset. Consumes the token, sets the new password and
 * revokes every existing session — the reset flow is treated as a hostile
 * takeover signal, so no session survives it.
 */
export async function resetPasswordWithToken(
  token: string,
  newPassword: string,
  meta: SecurityEventMeta = {},
): Promise<{ userId: string }> {
  const check = validatePassword(newPassword);
  if (!check.ok) throw Errors.VALIDATION_FAILED({ field: "newPassword" }, check.reason);

  const userId = await consumeEmailToken(token, "reset_password");
  if (!userId) throw Errors.TOKEN_INVALID();

  const hashed = await hashPassword(newPassword);
  await setpasswordHash(userId, hashed.hash, hashed.salt, hashed.params);
  const revoked = await revokeAllSessions(userId);
  await writeSecurityEvent(userId, "password_reset_completed", meta);
  if (revoked > 0) await writeSecurityEvent(userId, "sessions_revoked", meta);
  return { userId };
}

// ---------------------------------------------------------------------------
// Session revocation helpers (HTTP + realtime)
// ---------------------------------------------------------------------------

/** Revoke every session for a user except the one performing the action. */
export async function revokeOtherSessions(userId: string, exceptSessionId: string): Promise<number> {
  const revoked = await execute(
    `UPDATE sessions SET revoked_at = now()
      WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`,
    [userId, exceptSessionId],
  );
  if (revoked > 0) await disconnectUserSessions(userId, exceptSessionId);
  return revoked;
}

/** Revoke every session for a user (used by password reset). */
export async function revokeAllSessions(userId: string): Promise<number> {
  const revoked = await execute(
    `UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId],
  );
  if (revoked > 0) await disconnectUserSessions(userId);
  return revoked;
}

// ---------------------------------------------------------------------------
// TOTP two-factor authentication
// ---------------------------------------------------------------------------

interface MfaRow {
  mfa_enabled: boolean;
  mfa_secret_enc: string | null;
  email: string | null;
  username: string;
}

async function getMfaRow(userId: string): Promise<MfaRow | null> {
  return queryOne<MfaRow>(
    `SELECT mfa_enabled, mfa_secret_enc, email, username FROM users WHERE id = $1`,
    [userId],
  );
}

/**
 * Begin TOTP enrollment. Requires password reauthentication. An interrupted
 * previous enrollment is simply overwritten by a fresh secret. The secret is
 * encrypted at rest and mfa_enabled only flips once a code is confirmed.
 */
export async function startMfaEnrollment(
  userId: string,
  password: string,
  meta: SecurityEventMeta = {},
): Promise<{ secret: string; uri: string; qrDataUrl: string }> {
  const ok = await verifyUserPassword(userId, password);
  if (!ok) throw Errors.INVALID_CREDENTIALS(undefined, "Your password is not correct.");

  const row = await getMfaRow(userId);
  if (!row) throw Errors.UNKNOWN_USER();
  if (row.mfa_enabled) throw Errors.MFA_ALREADY_ENABLED();

  const secret = generateTotpSecret();
  await execute(`UPDATE users SET mfa_secret_enc = $2 WHERE id = $1`, [userId, encryptSecret(secret)]);
  await writeSecurityEvent(userId, "mfa_enrollment_started", meta);

  const label = row.email ?? row.username;
  const uri = getTotpUri(secret, label);
  const qrDataUrl = await generateQrCodeDataUrl(uri);
  return { secret, uri, qrDataUrl };
}

/** Abandon a pending (unconfirmed) enrollment by clearing the stored secret. */
export async function cancelMfaEnrollment(userId: string): Promise<void> {
  await execute(`UPDATE users SET mfa_secret_enc = NULL WHERE id = $1 AND mfa_enabled = FALSE`, [userId]);
}

/**
 * Activate enrollment by verifying a valid TOTP code against the pending
 * secret. On success: mfa_enabled = true, ten single-use recovery codes are
 * generated and returned in plaintext exactly once (only hashes are stored).
 */
export async function activateMfa(
  userId: string,
  code: string,
  meta: SecurityEventMeta = {},
): Promise<{ recoveryCodes: string[] }> {
  const row = await getMfaRow(userId);
  if (!row) throw Errors.UNKNOWN_USER();
  if (row.mfa_enabled) throw Errors.MFA_ALREADY_ENABLED();
  if (!row.mfa_secret_enc) throw Errors.MFA_NOT_ENROLLED(undefined, "Start enrollment first.");

  const secret = decryptSecret(row.mfa_secret_enc);
  if (!verifyTotpCode(secret, code)) throw Errors.INVALID_MFA_CODE();

  const recoveryCodes = await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE users SET mfa_enabled = TRUE, mfa_enrolled_at = now(), updated_at = now() WHERE id = $1`,
      [userId],
    );
    await tx.query(`DELETE FROM totp_recovery_codes WHERE user_id = $1`, [userId]);
    const codes = generateRecoveryCodes();
    for (const plain of codes) {
      await tx.query(
        `INSERT INTO totp_recovery_codes (id, user_id, code_hash) VALUES ($1, $2, $3)`,
        [nextId(), userId, hashRecoveryCode(plain)],
      );
    }
    return codes;
  });

  await writeSecurityEvent(userId, "mfa_enabled", meta);
  return { recoveryCodes };
}

/**
 * Disable 2FA. Requires password reauthentication plus either a valid TOTP
 * code or a valid unused recovery code.
 */
export async function disableMfa(
  userId: string,
  password: string,
  factor: { code?: string; recoveryCode?: string },
  meta: SecurityEventMeta = {},
): Promise<void> {
  const ok = await verifyUserPassword(userId, password);
  if (!ok) throw Errors.INVALID_CREDENTIALS(undefined, "Your password is not correct.");

  const row = await getMfaRow(userId);
  if (!row) throw Errors.UNKNOWN_USER();
  if (!row.mfa_enabled || !row.mfa_secret_enc) throw Errors.MFA_NOT_ENROLLED();

  const secret = decryptSecret(row.mfa_secret_enc);
  const codeOk = factor.code ? verifyTotpCode(secret, factor.code) : false;
  const recoveryOk = factor.recoveryCode ? await consumeRecoveryCode(userId, factor.recoveryCode) : false;
  if (!codeOk && !recoveryOk) throw Errors.INVALID_MFA_CODE();

  await execute(
    `UPDATE users SET mfa_enabled = FALSE, mfa_secret_enc = NULL, mfa_enrolled_at = NULL, updated_at = now()
      WHERE id = $1`,
    [userId],
  );
  await execute(`DELETE FROM totp_recovery_codes WHERE user_id = $1`, [userId]);
  await writeSecurityEvent(userId, "mfa_disabled", meta);
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/**
 * Format: 3 groups of 4 uppercase alphanumerics (Crockford base32 alphabet,
 * no ambiguous characters) — 20 bits of entropy per group from a CSPRNG.
 */
const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i += 1) {
    let code = "";
    for (let g = 0; g < 3; g += 1) {
      if (g > 0) code += "-";
      for (let c = 0; c < 4; c += 1) code += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
    }
    codes.push(code);
  }
  return codes;
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256").update(normalizeRecoveryCode(code)).digest("hex");
}

function normalizeRecoveryCode(code: string): string {
  return code.trim().toUpperCase().replace(/[^0-9A-Z]/g, "");
}

/** Consume a recovery code: succeeds at most once per code (conditional UPDATE). */
export async function consumeRecoveryCode(userId: string, code: string): Promise<boolean> {
  const rows = await query(
    `UPDATE totp_recovery_codes SET used_at = now()
      WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
      RETURNING id`,
    [userId, hashRecoveryCode(code)],
  );
  return rows.length > 0;
}

/** Count still-unused recovery codes (for the settings UI). */
export async function countUnusedRecoveryCodes(userId: string): Promise<number> {
  const rows = await query<{ count: string }>(
    `SELECT count(*)::text AS count FROM totp_recovery_codes WHERE user_id = $1 AND used_at IS NULL`,
    [userId],
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Regenerate recovery codes. Requires password reauthentication plus a valid
 * second factor; existing codes are replaced and become invalid.
 */
export async function regenerateRecoveryCodes(
  userId: string,
  password: string,
  factor: { code?: string; recoveryCode?: string },
  meta: SecurityEventMeta = {},
): Promise<string[]> {
  const ok = await verifyUserPassword(userId, password);
  if (!ok) throw Errors.INVALID_CREDENTIALS(undefined, "Your password is not correct.");

  const row = await getMfaRow(userId);
  if (!row?.mfa_enabled || !row.mfa_secret_enc) throw Errors.MFA_NOT_ENROLLED();

  const secret = decryptSecret(row.mfa_secret_enc);
  const codeOk = factor.code ? verifyTotpCode(secret, factor.code) : false;
  const recoveryOk = factor.recoveryCode ? await consumeRecoveryCode(userId, factor.recoveryCode) : false;
  if (!codeOk && !recoveryOk) throw Errors.INVALID_MFA_CODE();

  const codes = await withTransaction(async (tx) => {
    await tx.query(`DELETE FROM totp_recovery_codes WHERE user_id = $1`, [userId]);
    const generated = generateRecoveryCodes();
    for (const plain of generated) {
      await tx.query(`INSERT INTO totp_recovery_codes (id, user_id, code_hash) VALUES ($1, $2, $3)`, [
        nextId(),
        userId,
        hashRecoveryCode(plain),
      ]);
    }
    return generated;
  });
  await writeSecurityEvent(userId, "mfa_recovery_code_used", meta);
  return codes;
}

// ---------------------------------------------------------------------------
// Second-factor login challenges
// ---------------------------------------------------------------------------

export interface MfaChallengeRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  used_at: Date | null;
}

/**
 * Issue a short-lived, single-use challenge after the password factor has
 * passed for a 2FA-enabled account. The raw token is returned to the client
 * once; only its hash is stored.
 */
export async function createMfaChallenge(userId: string): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await execute(
    `INSERT INTO mfa_challenges (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))`,
    [nextId(), userId, hashToken(token), MFA_CHALLENGE_TTL_SECONDS],
  );
  return token;
}

/**
 * Verify the second factor and, on success, consume the challenge (single-use,
 * expiring). Returns null when the challenge is unknown/expired/already used or
 * the factor is wrong. Failed attempts do not consume the challenge — retries
 * are bounded by the endpoint's rate limiter — but a success can only be
 * redeemed once because the consume UPDATE is conditional on `used_at IS NULL`.
 */
export async function consumeMfaChallenge(
  challengeToken: string,
  factor: { code?: string; recoveryCode?: string },
  meta: SecurityEventMeta = {},
): Promise<{ userId: string; usedRecoveryCode: boolean } | null> {
  if (!challengeToken || challengeToken.length > 256) return null;

  const rows = await query<{ id: string; user_id: string }>(
    `SELECT id, user_id FROM mfa_challenges
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [hashToken(challengeToken)],
  );
  const challenge = rows[0];
  if (!challenge) return null;

  const row = await getMfaRow(challenge.user_id);
  if (!row?.mfa_enabled || !row.mfa_secret_enc) return null;

  const secret = decryptSecret(row.mfa_secret_enc);
  const codeOk = factor.code ? verifyTotpCode(secret, factor.code) : false;
  const recoveryOk = factor.recoveryCode ? await consumeRecoveryCode(challenge.user_id, factor.recoveryCode) : false;
  if (!codeOk && !recoveryOk) return null;

  // Redeem exactly once, even under concurrent requests.
  const redeemed = await query(
    `UPDATE mfa_challenges SET used_at = now() WHERE id = $1 AND used_at IS NULL RETURNING id`,
    [challenge.id],
  );
  if (redeemed.length === 0) return null;

  await writeSecurityEvent(
    challenge.user_id,
    recoveryOk && !codeOk ? "mfa_recovery_code_used" : "mfa_login_succeeded",
    meta,
  );
  return { userId: challenge.user_id, usedRecoveryCode: recoveryOk && !codeOk };
}

/** Look up the login identity for a pending challenge (never leaks the token). */
export async function getUserEmailForUser(userId: string): Promise<string | null> {
  const row = await queryOne<{ email: string | null }>(`SELECT email FROM users WHERE id = $1`, [userId]);
  return row?.email ?? null;
}

/** Password policy re-export so routes validate identically everywhere. */
export { validatePassword, Limits };
