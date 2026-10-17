import { Errors, Limits, Permissions, deserializePermissions, serializePermissions } from "@nebula/shared";
import { nextId } from "../ids.js";
import { execute, query, queryOne, type Tx } from "../db/pool.js";
import { AuditLogActionType } from "@nebula/shared";
import { bus } from "../realtime/bus.js";
import { writeAuditLog } from "./audit.js";
import { toRole, type RoleRow } from "./mappers.js";
import { assertCanGrantPermissions, assertHierarchy, loadMemberContext } from "./permissions.js";

const ROLE_COLUMNS = `id, guild_id, name, color, hoist, position, permissions, managed, mentionable, is_everyone`;

/** Create the @everyone role. Its id MUST equal the guild id (Discord convention). */
export async function createEveryoneRole(
  tx: Tx,
  guildId: string,
  permissions: bigint,
): Promise<void> {
  await tx.query(
    `INSERT INTO roles (id, guild_id, name, color, hoist, position, permissions, is_everyone, mentionable)
     VALUES ($1, $1, '@everyone', 0, FALSE, 0, $2, TRUE, FALSE)`,
    [guildId, serializePermissions(permissions)],
  );
}

export async function listGuildRoles(guildId: string) {
  const rows = await query<RoleRow>(
    `SELECT ${ROLE_COLUMNS} FROM roles WHERE guild_id = $1 ORDER BY position DESC, id ASC`,
    [guildId],
  );
  return rows.map(toRole);
}

export async function getRole(guildId: string, roleId: string): Promise<RoleRow> {
  const row = await queryOne<RoleRow>(
    `SELECT ${ROLE_COLUMNS} FROM roles WHERE guild_id = $1 AND id = $2`,
    [guildId, roleId],
  );
  if (!row) throw Errors.UNKNOWN_ROLE();
  return row;
}

export interface CreateRoleInput {
  name: string;
  color?: number;
  hoist?: boolean;
  mentionable?: boolean;
  permissions?: bigint;
}

export async function createRole(guildId: string, actorId: string, input: CreateRoleInput) {
  const ctx = await loadMemberContext(guildId, actorId);
  if ((ctx.basePermissions & Permissions.MANAGE_ROLES) !== Permissions.MANAGE_ROLES) {
    throw Errors.MISSING_PERMISSIONS({ permission: "MANAGE_ROLES" });
  }
  const granted = input.permissions ?? 0n;
  assertCanGrantPermissions(ctx, granted);

  const count = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM roles WHERE guild_id = $1`,
    [guildId],
  );
  if (Number(count?.count ?? 0) >= Limits.ROLES_MAX_PER_GUILD) {
    throw Errors.VALIDATION_FAILED(undefined, "This guild has reached the maximum number of roles.");
  }

  const name = input.name.trim().slice(0, 100) || "new role";
  const position = Math.min(ctx.highestRolePosition === Number.MAX_SAFE_INTEGER ? 1 : ctx.highestRolePosition, Number.MAX_SAFE_INTEGER - 1);

  const row = await queryOne<RoleRow>(
    `INSERT INTO roles (id, guild_id, name, color, hoist, position, permissions, mentionable)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${ROLE_COLUMNS}`,
    [
      nextId(),
      guildId,
      name,
      input.color ?? 0,
      input.hoist ?? false,
      position,
      serializePermissions(granted),
      input.mentionable ?? false,
    ],
  );
  if (!row) throw Errors.INTERNAL(undefined, "Failed to create role");

  await writeAuditLog({
    guildId,
    actionType: AuditLogActionType.ROLE_CREATE,
    actorId,
    targetId: row.id,
    changes: [{ key: "name", newValue: name }],
  });

  return toRole(row);
}

export interface UpdateRoleInput {
  name?: string;
  color?: number;
  hoist?: boolean;
  mentionable?: boolean;
  permissions?: bigint;
  position?: number;
}

export async function updateRole(guildId: string, roleId: string, actorId: string, input: UpdateRoleInput) {
  const ctx = await loadMemberContext(guildId, actorId);
  if ((ctx.basePermissions & Permissions.MANAGE_ROLES) !== Permissions.MANAGE_ROLES) {
    throw Errors.MISSING_PERMISSIONS({ permission: "MANAGE_ROLES" });
  }
  const existing = await getRole(guildId, roleId);

  // Hierarchy: you cannot edit a role at or above your highest role.
  assertHierarchy(ctx, existing.position);

  if (input.permissions !== undefined) {
    if (existing.is_everyone && !ctx.isOwner && (ctx.basePermissions & Permissions.ADMINISTRATOR) === 0n) {
      // Editing @everyone is allowed only if you can grant what you set.
      assertCanGrantPermissions(ctx, input.permissions);
    } else {
      assertCanGrantPermissions(ctx, input.permissions);
    }
    if (existing.managed) throw Errors.FORBIDDEN(undefined, "Managed roles cannot be modified.");
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (input.name !== undefined) {
    sets.push(`name = $${i++}`);
    params.push(input.name.trim().slice(0, 100) || "role");
  }
  if (input.color !== undefined) {
    sets.push(`color = $${i++}`);
    params.push(input.color);
  }
  if (input.hoist !== undefined) {
    sets.push(`hoist = $${i++}`);
    params.push(input.hoist);
  }
  if (input.mentionable !== undefined) {
    sets.push(`mentionable = $${i++}`);
    params.push(input.mentionable);
  }
  if (input.permissions !== undefined) {
    sets.push(`permissions = $${i++}`);
    params.push(serializePermissions(input.permissions));
  }
  if (input.position !== undefined) {
    if (input.position >= ctx.highestRolePosition && !ctx.isOwner) {
      throw Errors.HIERARCHY_VIOLATION({ reason: "cannot move a role above your highest role" });
    }
    sets.push(`position = $${i++}`);
    params.push(input.position);
  }

  if (sets.length === 0) return toRole(existing);
  params.push(guildId, roleId);

  const row = await queryOne<RoleRow>(
    `UPDATE roles SET ${sets.join(", ")} WHERE guild_id = $${i} AND id = $${i + 1} RETURNING ${ROLE_COLUMNS}`,
    params,
  );
  if (!row) throw Errors.UNKNOWN_ROLE();

  await writeAuditLog({
    guildId,
    actionType: AuditLogActionType.ROLE_UPDATE,
    actorId,
    targetId: roleId,
    changes: [{ key: "permissions", oldValue: existing.permissions, newValue: row.permissions }],
  });

  // Permissions changed for everyone holding this role.
  bus().refreshGuild?.(guildId);

  return toRole(row);
}

export async function deleteRole(guildId: string, roleId: string, actorId: string) {
  const ctx = await loadMemberContext(guildId, actorId);
  if ((ctx.basePermissions & Permissions.MANAGE_ROLES) !== Permissions.MANAGE_ROLES) {
    throw Errors.MISSING_PERMISSIONS({ permission: "MANAGE_ROLES" });
  }
  const existing = await getRole(guildId, roleId);
  if (existing.is_everyone) throw Errors.FORBIDDEN(undefined, "The @everyone role cannot be deleted.");
  if (existing.managed) throw Errors.FORBIDDEN(undefined, "Managed roles cannot be deleted.");
  assertHierarchy(ctx, existing.position);

  await execute(`DELETE FROM roles WHERE guild_id = $1 AND id = $2`, [guildId, roleId]);
  await writeAuditLog({
    guildId,
    actionType: AuditLogActionType.ROLE_DELETE,
    actorId,
    targetId: roleId,
    changes: [{ key: "name", oldValue: existing.name }],
  });
  bus().refreshGuild?.(guildId);
}

/** Replace a member's roles (excluding @everyone). Enforces hierarchy + grant checks. */
export async function setMemberRoles(
  guildId: string,
  targetUserId: string,
  roleIds: string[],
  actorId: string,
) {
  const ctx = await loadMemberContext(guildId, actorId);
  if ((ctx.basePermissions & Permissions.MANAGE_ROLES) !== Permissions.MANAGE_ROLES) {
    throw Errors.MISSING_PERMISSIONS({ permission: "MANAGE_ROLES" });
  }

  const targetMember = await queryOne<{ is_owner: boolean }>(
    `SELECT is_owner FROM guild_members WHERE guild_id = $1 AND user_id = $2`,
    [guildId, targetUserId],
  );
  if (!targetMember) throw Errors.NOT_GUILD_MEMBER();
  if (targetMember.is_owner) throw Errors.FORBIDDEN(undefined, "The guild owner's roles cannot be changed.");

  const unique = [...new Set(roleIds)];
  if (unique.length === 0) {
    await execute(`DELETE FROM member_roles WHERE guild_id = $1 AND user_id = $2`, [guildId, targetUserId]);
    return;
  }

  const roles = await query<RoleRow>(
    `SELECT ${ROLE_COLUMNS} FROM roles WHERE guild_id = $1 AND id = ANY($2::bigint[])`,
    [guildId, unique],
  );
  if (roles.length !== unique.length) throw Errors.UNKNOWN_ROLE();
  if (roles.some((r) => r.is_everyone)) throw Errors.VALIDATION_FAILED(undefined, "@everyone cannot be assigned explicitly.");

  for (const role of roles) {
    assertHierarchy(ctx, role.position);
    if (!ctx.isOwner && (ctx.basePermissions & Permissions.ADMINISTRATOR) === 0n) {
      const rolePerms = deserializePermissions(role.permissions);
      assertCanGrantPermissions(ctx, rolePerms);
    }
  }

  const highest = Math.max(...roles.map((r) => r.position), 0);
  assertHierarchy(ctx, highest);

  const client = await (await import("../db/pool.js")).pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM member_roles WHERE guild_id = $1 AND user_id = $2`, [guildId, targetUserId]);
    for (const roleId of unique) {
      await client.query(
        `INSERT INTO member_roles (guild_id, user_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [guildId, targetUserId, roleId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  await writeAuditLog({
    guildId,
    actionType: AuditLogActionType.MEMBER_ROLE_UPDATE,
    actorId,
    targetId: targetUserId,
    changes: [{ key: "$add", newValue: unique }],
  });

  // The target's effective permissions may have changed.
  bus().refreshGuild?.(guildId);
}

export async function getMemberRoleIds(guildId: string, userId: string): Promise<string[]> {
  const rows = await query<{ role_id: string }>(
    `SELECT role_id FROM member_roles WHERE guild_id = $1 AND user_id = $2`,
    [guildId, userId],
  );
  return rows.map((r) => r.role_id);
}
