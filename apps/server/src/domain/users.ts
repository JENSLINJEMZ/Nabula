import { Errors, Limits, generateDiscriminator, normalizeUsername } from "@nebula/shared";
import { nextId } from "../ids.js";
import { execute, query, queryOne, withTransaction } from "../db/pool.js";
import { hashPassword } from "../auth/passwords.js";
import { toPresence, toPublicUser, toSelfUser, type PresenceRow, type UserRow } from "./mappers.js";

const USER_COLUMNS = `id, username, discriminator, display_name, avatar_key, banner_key, accent_color,
  bio, bot, premium_type, email, email_verified, flags, created_at`;

export interface CreateUserInput {
  username: string;
  password: string;
  email?: string | null;
  displayName?: string | null;
  bot?: boolean;
  system?: boolean;
}

export interface CreatedUserRecord {
  user: UserRow;
}

/**
 * Create a user with credentials. Username uniqueness is enforced by a unique
 * index on the normalized (lowercased) username, so the check is race-free.
 */
export async function createUser(input: CreateUserInput): Promise<UserRow> {
  const username = normalizeUsername(input.username);
  if (!username) throw Errors.NAME_INVALID(undefined, "That username is not allowed.");

  const password = await hashPassword(input.password);
  const id = nextId();
  const emailLower = input.email ? input.email.trim().toLowerCase() : null;

  try {
    return await withTransaction(async (tx) => {
      const inserted = await tx.query<UserRow>(
        `INSERT INTO users (id, username, username_lower, discriminator, display_name, email,
                            password_hash, password_salt, password_params, bot, system)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         RETURNING ${USER_COLUMNS}`,
        [
          id,
          username,
          username.toLowerCase(),
          generateDiscriminator(),
          input.displayName ?? null,
          emailLower,
          password.hash,
          password.salt,
          password.params,
          input.bot ?? false,
          input.system ?? false,
        ],
      );
      await tx.query(`INSERT INTO user_settings (user_id) VALUES ($1)`, [id]);
      await tx.query(`INSERT INTO presence (user_id, status) VALUES ($1, 'offline')`, [id]);
      const row = inserted.rows[0];
      if (!row) throw Errors.INTERNAL(undefined, "Failed to create user");
      return row;
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw Errors.CONFLICT({ field: "username" }, "That username is already taken.");
    }
    throw error;
  }
}

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "23505"
  );
}

export async function getCredentials(
  username: string,
): Promise<(UserRow & { password_hash: string; password_salt: string; disabled: boolean }) | null> {
  return queryOne<UserRow & { password_hash: string; password_salt: string; disabled: boolean }>(
    `SELECT ${USER_COLUMNS}, password_hash, password_salt, disabled
       FROM users WHERE username_lower = $1`,
    [username.trim().toLowerCase()],
  );
}

export async function getUserById(id: string): Promise<UserRow | null> {
  return queryOne<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [id]);
}

/**
 * Prefix search over usernames and display names, for the "add friend" flow.
 * Excludes the viewer and bots, capped to a small result set.
 */
export async function searchUsers(queryText: string, excludeUserId: string, limit = 10): Promise<UserRow[]> {
  const q = queryText.trim().toLowerCase();
  if (q.length < 1) return [];
  const pattern = `${q.replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
  return query<UserRow>(
    `SELECT ${USER_COLUMNS}
       FROM users
      WHERE id <> $1
        AND bot = FALSE
        AND (username_lower LIKE $2 OR LOWER(display_name) LIKE $2)
      ORDER BY username_lower
      LIMIT $3`,
    [excludeUserId, pattern, Math.min(Math.max(limit, 1), 25)],
  );
}

export async function getSelfUser(id: string) {
  const row = await queryOne<UserRow & { mfa_enabled: boolean }>(
    `SELECT ${USER_COLUMNS}, FALSE AS mfa_enabled FROM users WHERE id = $1`,
    [id],
  );
  return row ? toSelfUser(row) : null;
}

export async function requireUserById(id: string): Promise<UserRow> {
  const row = await getUserById(id);
  if (!row) throw Errors.UNKNOWN_USER();
  return row;
}

export async function getPublicUsers(ids: string[]): Promise<Map<string, UserRow>> {
  if (ids.length === 0) return new Map();
  const rows = await query<UserRow>(`SELECT ${USER_COLUMNS} FROM users WHERE id = ANY($1::bigint[])`, [ids]);
  return new Map(rows.map((r) => [r.id, r]));
}

export interface UpdateProfileInput {
  displayName?: string | null;
  bio?: string | null;
  accentColor?: number | null;
  avatarKey?: string | null;
  bannerKey?: string | null;
  email?: string | null;
}

export async function updateProfile(userId: string, input: UpdateProfileInput): Promise<UserRow> {
  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;

  if (input.displayName !== undefined) {
    sets.push(`display_name = $${i++}`);
    params.push(input.displayName);
  }
  if (input.bio !== undefined) {
    if (input.bio !== null && input.bio.length > 190) throw Errors.VALIDATION_FAILED({ field: "bio" }, "Bio is too long.");
    sets.push(`bio = $${i++}`);
    params.push(input.bio);
  }
  if (input.accentColor !== undefined) {
    if (input.accentColor !== null && (input.accentColor < 0 || input.accentColor > 0xffffff)) {
      throw Errors.VALIDATION_FAILED({ field: "accentColor" }, "accentColor must be a 24-bit colour.");
    }
    sets.push(`accent_color = $${i++}`);
    params.push(input.accentColor);
  }
  if (input.avatarKey !== undefined) {
    sets.push(`avatar_key = $${i++}`);
    params.push(input.avatarKey);
  }
  if (input.bannerKey !== undefined) {
    sets.push(`banner_key = $${i++}`);
    params.push(input.bannerKey);
  }
  if (input.email !== undefined) {
    sets.push(`email = $${i++}`);
    params.push(input.email ? input.email.trim().toLowerCase() : null);
    sets.push(`email_verified = FALSE`);
  }

  if (sets.length === 0) return requireUserById(userId);

  sets.push(`updated_at = now()`);
  params.push(userId);

  try {
    const row = await queryOne<UserRow>(
      `UPDATE users SET ${sets.join(", ")} WHERE id = $${i} RETURNING ${USER_COLUMNS}`,
      params,
    );
    if (!row) throw Errors.UNKNOWN_USER();
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) throw Errors.CONFLICT({ field: "email" }, "That email is already in use.");
    throw error;
  }
}

export async function getUserPresence(userId: string) {
  const row = await queryOne<PresenceRow>(
    `SELECT user_id, status, custom_status, activities, updated_at FROM presence WHERE user_id = $1`,
    [userId],
  );
  return row ? toPresence(row) : null;
}

export async function getPresences(userIds: string[]) {
  if (userIds.length === 0) return [];
  const rows = await query<PresenceRow>(
    `SELECT user_id, status, custom_status, activities, updated_at FROM presence WHERE user_id = ANY($1::bigint[])`,
    [userIds],
  );
  return rows.map(toPresence);
}

export async function setPresence(
  userId: string,
  status: string,
  customStatus: string | null,
  activities: unknown[] = [],
): Promise<void> {
  await execute(
    `INSERT INTO presence (user_id, status, custom_status, activities, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (user_id) DO UPDATE
       SET status = EXCLUDED.status,
           custom_status = EXCLUDED.custom_status,
           activities = EXCLUDED.activities,
           updated_at = now()`,
    [userId, status, customStatus, JSON.stringify(activities)],
  );
}

/** Bulk presence lookup keyed by user id, for member lists. */
export async function getPresenceMap(userIds: string[]): Promise<Map<string, ReturnType<typeof toPresence>>> {
  const list = await getPresences(userIds);
  return new Map(list.map((p) => [p.userId, p]));
}

export { toPublicUser, toSelfUser };
export const userLimits = Limits;
