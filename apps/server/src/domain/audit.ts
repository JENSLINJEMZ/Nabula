import type { AuditLogChange, AuditLogEntry } from "@nebula/shared";
import { nextId } from "../ids.js";
import { pool, query, type Queryable } from "../db/pool.js";
import { toAuditLogEntry, toPublicUser, type UserRow } from "./mappers.js";

export interface AuditLogInput {
  guildId: string;
  actionType: number;
  actorId: string | null;
  targetId?: string | null;
  reason?: string | null;
  changes?: AuditLogChange[];
}

/** Build a diff entry list for an audit record. */
export function diff<T>(key: string, oldValue: T, newValue: T): AuditLogChange | null {
  if (oldValue === newValue) return null;
  return { key, oldValue, newValue };
}

export function compact(changes: (AuditLogChange | null)[]): AuditLogChange[] {
  return changes.filter((c): c is AuditLogChange => c !== null);
}

/**
 * Append an audit-log entry. Accepts a transaction client so the write can be
 * atomic with the action it describes.
 */
export async function writeAuditLog(
  input: AuditLogInput,
  client: Queryable = pool,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log_entries (id, guild_id, action_type, actor_id, target_id, reason, changes)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [
      nextId(),
      input.guildId,
      input.actionType,
      input.actorId,
      input.targetId ?? null,
      input.reason ?? null,
      JSON.stringify(input.changes ?? []),
    ],
  );
}

export async function listAuditLog(
  guildId: string,
  options: { limit: number; before?: string | null; actionType?: number | null },
): Promise<AuditLogEntry[]> {
  const params: unknown[] = [guildId];
  const clauses = ["guild_id = $1"];
  let i = 2;
  if (options.before) {
    clauses.push(`id < $${i++}`);
    params.push(options.before);
  }
  if (options.actionType) {
    clauses.push(`action_type = $${i++}`);
    params.push(options.actionType);
  }
  params.push(options.limit);

  const rows = await query<{
    id: string;
    guild_id: string;
    action_type: number;
    actor_id: string | null;
    target_id: string | null;
    reason: string | null;
    changes: unknown;
    created_at: Date;
  }>(
    `SELECT id, guild_id, action_type, actor_id, target_id, reason, changes, created_at
       FROM audit_log_entries
      WHERE ${clauses.join(" AND ")}
      ORDER BY id DESC
      LIMIT $${i}`,
    params,
  );

  const actorIds = [...new Set(rows.map((r) => r.actor_id).filter((v): v is string => Boolean(v)))];
  const actors = new Map<string, UserRow>();
  if (actorIds.length > 0) {
    const actorRows = await query<UserRow>(
      `SELECT id, username, discriminator, display_name, avatar_key, banner_key, accent_color, bio,
              bot, premium_type, email, email_verified, flags, created_at
         FROM users WHERE id = ANY($1::bigint[])`,
      [actorIds],
    );
    for (const a of actorRows) actors.set(a.id, a);
  }

  return rows.map((r) => {
    const actorRow = r.actor_id ? actors.get(r.actor_id) : undefined;
    return toAuditLogEntry(r, actorRow ? toPublicUser(actorRow) : null);
  });
}
