import { Errors, Limits, RelationshipType } from "@nebula/shared";
import { query, queryOne, withTransaction, txQuery } from "../db/pool.js";
import { toPublicUser, toRelationship, type UserRow } from "./mappers.js";

async function getUserRow(id: string): Promise<UserRow | null> {
  return queryOne<UserRow>(
    `SELECT id, username, discriminator, display_name, avatar_key, banner_key, accent_color, bio, bot,
            premium_type, email, email_verified, flags, created_at
       FROM users WHERE id = $1`,
    [id],
  );
}

async function getRelationship(userId: string, targetId: string) {
  return queryOne<{ type: number; created_at: Date }>(
    `SELECT type, created_at FROM relationships WHERE user_id = $1 AND target_id = $2`,
    [userId, targetId],
  );
}

export async function areFriends(a: string, b: string): Promise<boolean> {
  const row = await getRelationship(a, b);
  return row?.type === RelationshipType.FRIEND;
}

/** True when either user has blocked the other. */
export async function isBlockedBetween(a: string, b: string): Promise<boolean> {
  const row = await queryOne<{ blocked: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM relationships
        WHERE type = 2 AND ((user_id = $1 AND target_id = $2) OR (user_id = $2 AND target_id = $1))
     ) AS blocked`,
    [a, b],
  );
  return Boolean(row?.blocked);
}

export async function getBlockedIds(userId: string): Promise<Set<string>> {
  const rows = await query<{ target_id: string }>(
    `SELECT target_id FROM relationships WHERE user_id = $1 AND type = 2`,
    [userId],
  );
  return new Set(rows.map((r) => r.target_id));
}

/** Users blocked by `userId`, or who blocked `userId`. */
export async function getAllBlockedEitherDirection(userId: string): Promise<Set<string>> {
  const rows = await query<{ other: string }>(
    `SELECT CASE WHEN user_id = $1 THEN target_id ELSE user_id END AS other
       FROM relationships WHERE type = 2 AND (user_id = $1 OR target_id = $1)`,
    [userId],
  );
  return new Set(rows.map((r) => r.other));
}

export async function listRelationships(userId: string) {
  const rows = await query<{ user_id: string; target_id: string; type: number; created_at: Date }>(
    `SELECT user_id, target_id, type, created_at FROM relationships
      WHERE user_id = $1 AND type <> 2
      ORDER BY created_at DESC`,
    [userId],
  );
  if (rows.length === 0) return [];

  const targetIds = rows.map((r) => r.target_id);
  const users = await query<UserRow>(
    `SELECT id, username, discriminator, display_name, avatar_key, banner_key, accent_color, bio, bot,
            premium_type, email, email_verified, flags, created_at
       FROM users WHERE id = ANY($1::bigint[])`,
    [targetIds],
  );
  const userMap = new Map(users.map((u) => [u.id, toPublicUser(u)]));

  return rows
    .map((r) => {
      const user = userMap.get(r.target_id);
      return user ? toRelationship(r, user) : null;
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);
}

/**
 * Send (or auto-accept) a friend request.
 * Rules enforced:
 *  - cannot target yourself
 *  - a block in either direction blocks the request
 *  - mutual pending requests auto-accept into a friendship
 */
export async function sendFriendRequest(userId: string, targetId: string): Promise<"pending" | "accepted"> {
  if (userId === targetId) throw Errors.CANNOT_FRIEND_SELF();

  const target = await getUserRow(targetId);
  if (!target) throw Errors.UNKNOWN_USER();

  if (await isBlockedBetween(userId, targetId)) throw Errors.BLOCKED();

  const mine = await getRelationship(userId, targetId);
  if (mine?.type === RelationshipType.FRIEND) throw Errors.ALREADY_FRIENDS();
  if (mine?.type === RelationshipType.OUTGOING_REQUEST) return "pending";

  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM relationships WHERE user_id = $1 AND type = 1`,
    [userId],
  );
  if (Number(countRow?.count ?? 0) >= Limits.FRIENDS_MAX) {
    throw Errors.VALIDATION_FAILED(undefined, "You have reached the maximum number of friends.");
  }

  // Mutual request => accept immediately.
  if (mine?.type === RelationshipType.INCOMING_REQUEST) {
    await acceptFriendRequest(userId, targetId);
    return "accepted";
  }

  await withTransaction(async (tx) => {
    await txQuery(
      tx,
      `INSERT INTO relationships (user_id, target_id, type) VALUES ($1, $2, 4)
       ON CONFLICT (user_id, target_id) DO UPDATE SET type = 4, created_at = now()`,
      [userId, targetId],
    );
    await txQuery(
      tx,
      `INSERT INTO relationships (user_id, target_id, type) VALUES ($1, $2, 3)
       ON CONFLICT (user_id, target_id) DO UPDATE SET type = 3, created_at = now()`,
      [targetId, userId],
    );
  });
  return "pending";
}

export async function acceptFriendRequest(userId: string, requesterId: string): Promise<void> {
  const incoming = await getRelationship(userId, requesterId);
  if (incoming?.type !== RelationshipType.INCOMING_REQUEST) {
    throw Errors.NOT_FOUND(undefined, "No pending friend request from that user.");
  }
  if (await isBlockedBetween(userId, requesterId)) throw Errors.BLOCKED();

  await withTransaction(async (tx) => {
    await txQuery(
      tx,
      `INSERT INTO relationships (user_id, target_id, type) VALUES ($1, $2, 1)
       ON CONFLICT (user_id, target_id) DO UPDATE SET type = 1, created_at = now()`,
      [userId, requesterId],
    );
    await txQuery(
      tx,
      `INSERT INTO relationships (user_id, target_id, type) VALUES ($1, $2, 1)
       ON CONFLICT (user_id, target_id) DO UPDATE SET type = 1, created_at = now()`,
      [requesterId, userId],
    );
  });
}

/** Remove a friend, cancel a pending request, or dismiss an incoming one. */
export async function removeRelationship(userId: string, targetId: string): Promise<void> {
  const existing = await getRelationship(userId, targetId);
  if (!existing) return;

  if (existing.type === RelationshipType.BLOCKED) {
    throw Errors.VALIDATION_FAILED(undefined, "Unblock the user instead of removing the relationship.");
  }

  await withTransaction(async (tx) => {
    await txQuery(tx, `DELETE FROM relationships WHERE user_id = $1 AND target_id = $2`, [userId, targetId]);
    // Only remove the reciprocal row when it is a friend/request pairing, never a block.
    await txQuery(
      tx,
      `DELETE FROM relationships WHERE user_id = $1 AND target_id = $2 AND type <> 2`,
      [targetId, userId],
    );
  });
}

/**
 * Block a user: records a one-way block, severs any friendship and cancels
 * pending requests in both directions.
 */
export async function blockUser(userId: string, targetId: string): Promise<void> {
  if (userId === targetId) throw Errors.VALIDATION_FAILED(undefined, "You cannot block yourself.");
  const target = await getUserRow(targetId);
  if (!target) throw Errors.UNKNOWN_USER();

  const existing = await getRelationship(userId, targetId);
  if (existing?.type === RelationshipType.BLOCKED) throw Errors.ALREADY_BLOCKED();

  await withTransaction(async (tx) => {
    // Sever friendship / requests in both directions.
    await txQuery(
      tx,
      `DELETE FROM relationships WHERE type <> 2 AND ((user_id = $1 AND target_id = $2) OR (user_id = $2 AND target_id = $1))`,
      [userId, targetId],
    );
    await txQuery(
      tx,
      `INSERT INTO relationships (user_id, target_id, type) VALUES ($1, $2, 2)
       ON CONFLICT (user_id, target_id) DO UPDATE SET type = 2, created_at = now()`,
      [userId, targetId],
    );
  });
}

export async function unblockUser(userId: string, targetId: string): Promise<void> {
  const existing = await getRelationship(userId, targetId);
  if (existing?.type !== RelationshipType.BLOCKED) {
    throw Errors.NOT_FOUND(undefined, "That user is not blocked.");
  }
  await query(`DELETE FROM relationships WHERE user_id = $1 AND target_id = $2 AND type = 2`, [userId, targetId]);
}

export { getUserRow };
