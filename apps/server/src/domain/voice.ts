import { ChannelType, Errors, Permissions, ServerEvents } from "@nebula/shared";
import { execute, query, queryOne } from "../db/pool.js";
import { bus } from "../realtime/bus.js";
import { requireChannelRow } from "./channels.js";
import { toVoiceState } from "./mappers.js";
import { assertChannelAccess, loadMemberContext } from "./permissions.js";

export interface VoiceStateRow {
  guild_id: string | null;
  channel_id: string;
  user_id: string;
  session_id: string;
  self_mute: boolean;
  self_deaf: boolean;
  self_stream: boolean;
  self_video: boolean;
  mute: boolean;
  deaf: boolean;
  suppress: boolean;
  joined_at: Date;
}

const VS_COLUMNS = `guild_id, channel_id, user_id, session_id, self_mute, self_deaf, self_stream,
  self_video, mute, deaf, suppress, joined_at`;

export async function listVoiceStates(channelId: string) {
  const rows = await query<VoiceStateRow>(`SELECT ${VS_COLUMNS} FROM voice_states WHERE channel_id = $1`, [channelId]);
  return rows.map(toVoiceState);
}

export async function getVoiceStateForUser(userId: string) {
  const row = await queryOne<VoiceStateRow>(`SELECT ${VS_COLUMNS} FROM voice_states WHERE user_id = $1`, [userId]);
  return row ? toVoiceState(row) : null;
}

export interface JoinVoiceInput {
  guildId: string | null;
  channelId: string;
  userId: string;
  sessionId: string;
  selfMute?: boolean;
  selfDeaf?: boolean;
  selfVideo?: boolean;
}

/**
 * Join a voice channel. Requires CONNECT; if the guild is configured so and the
 * channel is full, rejects. A user may be in only one voice channel at a time
 * (enforced by the primary key on voice_states.user_id).
 */
export async function joinVoiceChannel(input: JoinVoiceInput) {
  const channel = await requireChannelRow(input.channelId);
  if (channel.type !== ChannelType.GUILD_VOICE && channel.type !== ChannelType.GUILD_STAGE_VOICE) {
    throw Errors.UNSUPPORTED_CHANNEL_TYPE(undefined, "That channel is not a voice channel.");
  }

  const access = await assertChannelAccess(input.channelId, input.userId, Permissions.CONNECT);
  const guildId = channel.guild_id;

  if (guildId) {
    const ctx = await loadMemberContext(guildId, input.userId);
    if ((ctx.basePermissions & Permissions.CONNECT) !== Permissions.CONNECT) {
      throw Errors.MISSING_PERMISSIONS({ permission: "CONNECT" });
    }
  }
  void access;

  if (channel.user_limit > 0) {
    const count = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM voice_states WHERE channel_id = $1`,
      [input.channelId],
    );
    const existing = await queryOne(`SELECT 1 FROM voice_states WHERE user_id = $1 AND channel_id = $2`, [
      input.userId,
      input.channelId,
    ]);
    if (!existing && Number(count?.count ?? 0) >= channel.user_limit) {
      throw Errors.FORBIDDEN(undefined, "That voice channel is full.");
    }
  }

  // A deafened user is implicitly muted (Discord semantics).
  const selfDeaf = input.selfDeaf ?? false;
  const selfMute = input.selfMute ?? false;

  const row = await queryOne<VoiceStateRow>(
    `INSERT INTO voice_states (user_id, guild_id, channel_id, session_id, self_mute, self_deaf, self_video, mute)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $5)
     ON CONFLICT (user_id) DO UPDATE
       SET guild_id = EXCLUDED.guild_id,
           channel_id = EXCLUDED.channel_id,
           session_id = EXCLUDED.session_id,
           self_mute = EXCLUDED.self_mute,
           self_deaf = EXCLUDED.self_deaf,
           self_video = EXCLUDED.self_video,
           mute = EXCLUDED.mute,
           joined_at = now()
     RETURNING ${VS_COLUMNS}`,
    [input.userId, guildId, input.channelId, input.sessionId, selfMute, selfDeaf, input.selfVideo ?? false],
  );
  if (!row) throw Errors.INTERNAL(undefined, "Failed to join voice channel");

  const state = toVoiceState(row);
  if (guildId) bus().toGuild(guildId, ServerEvents.VOICE_STATE_UPDATE, state);
  else bus().toChannel(input.channelId, ServerEvents.VOICE_STATE_UPDATE, state);

  const peers = (await listVoiceStates(input.channelId)).filter((v) => v.userId !== input.userId);
  return { state, peers };
}

export interface UpdateVoiceStateInput {
  selfMute?: boolean;
  selfDeaf?: boolean;
  selfStream?: boolean;
  selfVideo?: boolean;
}

export async function updateVoiceState(userId: string, input: UpdateVoiceStateInput) {
  const current = await getVoiceStateForUser(userId);
  if (!current) throw Errors.NOT_FOUND(undefined, "You are not connected to a voice channel.");

  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  // Deafen implies mute; undeafening does not unmute.
  if (input.selfDeaf !== undefined) {
    sets.push(`self_deaf = $${i++}`);
    params.push(input.selfDeaf);
    if (input.selfDeaf) {
      sets.push(`self_mute = TRUE`);
      sets.push(`mute = TRUE`);
    }
  }
  if (input.selfMute !== undefined) {
    sets.push(`self_mute = $${i++}`);
    params.push(input.selfMute);
    sets.push(`mute = $${i - 1}`);
  }
  if (input.selfStream !== undefined) {
    sets.push(`self_stream = $${i++}`);
    params.push(input.selfStream);
  }
  if (input.selfVideo !== undefined) {
    sets.push(`self_video = $${i++}`);
    params.push(input.selfVideo);
  }
  if (sets.length === 0) return current;

  params.push(userId);
  const row = await queryOne<VoiceStateRow>(
    `UPDATE voice_states SET ${sets.join(", ")} WHERE user_id = $${i} RETURNING ${VS_COLUMNS}`,
    params,
  );
  if (!row) throw Errors.NOT_FOUND();

  const state = toVoiceState(row);
  if (state.guildId) bus().toGuild(state.guildId, ServerEvents.VOICE_STATE_UPDATE, state);
  else bus().toChannel(state.channelId, ServerEvents.VOICE_STATE_UPDATE, state);
  return state;
}

export async function leaveVoice(userId: string): Promise<{ channelId: string; guildId: string | null } | null> {
  const row = await queryOne<{ channel_id: string; guild_id: string | null }>(
    `DELETE FROM voice_states WHERE user_id = $1 RETURNING channel_id, guild_id`,
    [userId],
  );
  if (!row) return null;

  const payload = {
    userId,
    channelId: row.channel_id,
    guildId: row.guild_id,
    left: true,
    selfMute: false,
    selfDeaf: false,
    selfStream: false,
    selfVideo: false,
    mute: false,
    deaf: false,
    suppress: false,
    sessionId: "",
  };
  if (row.guild_id) bus().toGuild(row.guild_id, ServerEvents.VOICE_STATE_UPDATE, payload);
  else bus().toChannel(row.channel_id, ServerEvents.VOICE_STATE_UPDATE, payload);
  return { channelId: row.channel_id, guildId: row.guild_id };
}

/** Server-side moderation of a member's voice state (mute/deaf/move). */
export async function moderateVoiceState(
  guildId: string,
  targetUserId: string,
  actorId: string,
  patch: { mute?: boolean; deaf?: boolean; channelId?: string },
) {
  const ctx = await loadMemberContext(guildId, actorId);
  if (patch.channelId) {
    if ((ctx.basePermissions & Permissions.MOVE_MEMBERS) !== Permissions.MOVE_MEMBERS) {
      throw Errors.MISSING_PERMISSIONS({ permission: "MOVE_MEMBERS" });
    }
  }
  if (patch.mute !== undefined && (ctx.basePermissions & Permissions.MUTE_MEMBERS) !== Permissions.MUTE_MEMBERS) {
    throw Errors.MISSING_PERMISSIONS({ permission: "MUTE_MEMBERS" });
  }
  if (patch.deaf !== undefined && (ctx.basePermissions & Permissions.DEAFEN_MEMBERS) !== Permissions.DEAFEN_MEMBERS) {
    throw Errors.MISSING_PERMISSIONS({ permission: "DEAFEN_MEMBERS" });
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let i = 1;
  if (patch.mute !== undefined) {
    sets.push(`mute = $${i++}`);
    params.push(patch.mute);
  }
  if (patch.deaf !== undefined) {
    sets.push(`deaf = $${i++}`);
    params.push(patch.deaf);
    if (patch.deaf) sets.push(`mute = TRUE`);
  }
  if (patch.channelId !== undefined) {
    sets.push(`channel_id = $${i++}`);
    params.push(patch.channelId);
  }
  if (sets.length === 0) return null;

  params.push(targetUserId);
  const row = await queryOne<VoiceStateRow>(
    `UPDATE voice_states SET ${sets.join(", ")} WHERE user_id = $${i} RETURNING ${VS_COLUMNS}`,
    params,
  );
  if (!row) throw Errors.NOT_FOUND(undefined, "That user is not in a voice channel.");

  const state = toVoiceState(row);
  bus().toGuild(guildId, ServerEvents.VOICE_STATE_UPDATE, state);
  return state;
}

/** Called on disconnect to clear any voice presence for the user. */
export async function clearVoiceOnDisconnect(userId: string): Promise<void> {
  await leaveVoice(userId).catch(() => undefined);
}
