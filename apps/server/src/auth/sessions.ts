import { createHash, randomBytes } from "node:crypto";
import { Errors } from "@nebula/shared";
import { env } from "../config.js";
import { execute, query, queryOne } from "../db/pool.js";
import { nextId } from "../ids.js";
import { safeEqual } from "./passwords.js";

export const SESSION_COOKIE = "nebula_session";
export const CSRF_COOKIE = "nebula_csrf";
export const CSRF_HEADER = "x-csrf-token";

export interface SessionRow {
  id: string;
  user_id: string;
  csrf_secret: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  ip: string | null;
  user_agent: string | null;
  client_name: string | null;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface CreatedSession {
  session: SessionRow;
  /** Raw bearer token; only ever returned to the client, never persisted. */
  token: string;
  /** Double-submit CSRF token bound to this session. */
  csrfToken: string;
  expiresAt: Date;
}

export interface CreateSessionInput {
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
  clientName?: string | null;
}

/**
 * Create a session. The database stores only SHA-256(token) and the CSRF secret,
 * so a database leak does not yield usable session tokens.
 */
export async function createSession(input: CreateSessionInput): Promise<CreatedSession> {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + env.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

  const rows = await query<SessionRow>(
    `INSERT INTO sessions (id, user_id, token_hash, csrf_secret, ip, user_agent, client_name, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, user_id, csrf_secret, created_at, last_seen_at, expires_at, revoked_at, ip, user_agent, client_name`,
    [nextId(), input.userId, hashToken(token), csrfToken, input.ip ?? null, input.userAgent ?? null, input.clientName ?? null, expiresAt],
  );
  const session = rows[0];
  if (!session) throw Errors.INTERNAL(undefined, "Failed to create session");
  return { session, token, csrfToken, expiresAt };
}

export interface ResolvedSession {
  session: SessionRow;
  userId: string;
}

/**
 * Resolve a raw session token. Returns null for unknown, revoked, expired or
 * suspended-account sessions. Never distinguishes those cases to the caller
 * beyond an unauthenticated error.
 */
export async function resolveSession(token: string | undefined | null): Promise<ResolvedSession | null> {
  if (!token || token.length < 16) return null;
  const row = await queryOne<SessionRow & { user_disabled: boolean }>(
    `SELECT s.id, s.user_id, s.csrf_secret, s.created_at, s.last_seen_at, s.expires_at,
            s.revoked_at, s.ip, s.user_agent, s.client_name, u.disabled AS user_disabled
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()`,
    [hashToken(token)],
  );
  if (!row) return null;
  if (row.user_disabled) return null;

  // Best-effort liveness update; failure here must not fail the request.
  void execute("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [row.id]).catch(() => undefined);

  return { session: row, userId: row.user_id };
}

export async function verifyCsrf(session: SessionRow, headerToken: string | undefined): Promise<void> {
  if (!headerToken) throw Errors.INVALID_CSRF();
  if (!safeEqual(headerToken, session.csrf_secret)) throw Errors.INVALID_CSRF();
}

export async function revokeSession(sessionId: string): Promise<void> {
  await execute("UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [sessionId]);
}

export async function revokeAllSessionsForUser(userId: string, exceptSessionId?: string): Promise<number> {
  if (exceptSessionId) {
    return execute(
      "UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL",
      [userId, exceptSessionId],
    );
  }
  return execute("UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [userId]);
}

export interface SessionDeviceInfo {
  id: string;
  clientName: string | null;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  current: boolean;
}

export async function listSessionsForUser(userId: string, currentSessionId: string): Promise<SessionDeviceInfo[]> {
  const rows = await query<{
    id: string;
    client_name: string | null;
    ip: string | null;
    user_agent: string | null;
    created_at: Date;
    last_seen_at: Date;
  }>(
    `SELECT id, client_name, ip, user_agent, created_at, last_seen_at
       FROM sessions
      WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY last_seen_at DESC
      LIMIT 100`,
    [userId],
  );
  return rows.map((r) => ({
    id: r.id,
    clientName: r.client_name,
    ip: r.ip,
    userAgent: r.user_agent,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    current: r.id === currentSessionId,
  }));
}

export async function purgeExpiredSessions(): Promise<number> {
  return execute(
    "DELETE FROM sessions WHERE expires_at < now() - interval '7 days' OR (revoked_at IS NOT NULL AND revoked_at < now() - interval '7 days')",
  );
}
