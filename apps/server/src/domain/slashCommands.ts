import { Errors, MessageType, Permissions, ServerEvents } from "@nebula/shared";
import { nextId } from "../ids.js";
import { execute, query, queryOne } from "../db/pool.js";
import { bus } from "../realtime/bus.js";
import { requireChannelRow } from "./channels.js";
import { createMessage } from "./messages.js";
import { assertChannelAccess, loadMemberContext } from "./permissions.js";
import { timeoutMember } from "./moderation.js";

/**
 * First-party application + built-in slash commands.
 *
 * This is intentionally an in-process command implementation rather than a
 * third-party bot/OAuth platform: it covers interaction plumbing (registration,
 * permission gating, invocation, response) without pretending to be a full
 * developer platform.
 */

export const BUILTIN_APPLICATION_NAME = "Nebula";

export interface CommandOption {
  name: string;
  description: string;
  type: number;
  required?: boolean;
}

export interface CommandDefinition {
  name: string;
  description: string;
  options: CommandOption[];
  /** Permission required to invoke. */
  permission?: bigint;
  /** Whether the command may be used in DMs. */
  dmCapable?: boolean;
}

export const BUILTIN_COMMANDS: CommandDefinition[] = [
  { name: "ping", description: "Check the gateway latency.", options: [], dmCapable: true },
  { name: "help", description: "List the available commands.", options: [], dmCapable: true },
  { name: "shrug", description: "Append a shrug to your message.", options: [{ name: "text", description: "Optional text", type: 3 }], dmCapable: true },
  { name: "me", description: "Send an action message.", options: [{ name: "text", description: "The action", type: 3, required: true }], dmCapable: true },
  { name: "user", description: "Show information about a user.", options: [{ name: "user", description: "User mention or id", type: 6 }], dmCapable: true },
  { name: "server", description: "Show information about this server.", options: [], permission: Permissions.VIEW_CHANNEL },
  {
    name: "nick",
    description: "Change your nickname in this server.",
    options: [{ name: "nickname", description: "The new nickname", type: 3, required: true }],
    permission: Permissions.CHANGE_NICKNAME,
  },
  {
    name: "slowmode",
    description: "Set the channel slowmode in seconds.",
    options: [{ name: "seconds", description: "Seconds between messages (0 disables)", type: 4, required: true }],
    permission: Permissions.MANAGE_CHANNELS,
  },
  {
    name: "timeout",
    description: "Time out a member.",
    options: [
      { name: "user", description: "The member to time out", type: 6, required: true },
      { name: "seconds", description: "Duration in seconds", type: 4, required: true },
      { name: "reason", description: "Reason", type: 3 },
    ],
    permission: Permissions.MODERATE_MEMBERS,
  },
];

/**
 * Ensure the built-in application and its global commands exist. Idempotent;
 * call on startup.
 */
export async function ensureBuiltinCommands(): Promise<void> {
  let application = await queryOne<{ id: string }>(
    `SELECT id FROM applications WHERE name = $1 AND owner_id IS NULL LIMIT 1`,
    [BUILTIN_APPLICATION_NAME],
  );
  if (!application) {
    const id = nextId();
    const inserted = await queryOne<{ id: string }>(
      `INSERT INTO applications (id, name, description, owner_id)
       VALUES ($1, $2, $3, NULL)
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [id, BUILTIN_APPLICATION_NAME, "Nebula's built-in commands"],
    );
    application = inserted ?? (await queryOne<{ id: string }>(
      `SELECT id FROM applications WHERE name = $1 AND owner_id IS NULL LIMIT 1`,
      [BUILTIN_APPLICATION_NAME],
    ));
  }
  if (!application) throw Errors.INTERNAL(undefined, "Failed to bootstrap built-in application");

  for (const command of BUILTIN_COMMANDS) {
    await execute(
      `INSERT INTO slash_commands (id, application_id, guild_id, name, description, options)
       VALUES ($1, $2, NULL, $3, $4, $5::jsonb)
       ON CONFLICT (application_id, name) WHERE guild_id IS NULL DO NOTHING`,
      [nextId(), application.id, command.name, command.description, JSON.stringify(command.options)],
    ).catch(async () => {
      // Partial/unique-index conflict: fall back to an existence check.
      const existing = await queryOne(`SELECT 1 FROM slash_commands WHERE application_id = $1 AND name = $2 AND guild_id IS NULL`, [
        application!.id,
        command.name,
      ]);
      if (!existing) throw Errors.INTERNAL(undefined, "Failed to register built-in command");
    });
  }
}

export async function listCommands(guildId?: string | null) {
  const rows = await query<{ id: string; name: string; description: string; options: unknown; application_id: string | null }>(
    `SELECT id, name, description, options, application_id
       FROM slash_commands
      WHERE guild_id IS NULL ${guildId ? "OR guild_id = $1" : ""}
      ORDER BY name ASC`,
    guildId ? [guildId] : [],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    options: Array.isArray(r.options) ? r.options : [],
  }));
}

export interface InvokeCommandInput {
  name: string;
  args: Record<string, string | number | undefined>;
  channelId: string;
  userId: string;
  /** Round-trip marker so clients can correlate a response with the invocation. */
  invocationId?: string;
}

export interface CommandResult {
  command: string;
  invocationId: string | null;
  content: string;
  ephemeral: boolean;
}

/**
 * Invoke a built-in command. Content commands post a normal message; informational
 * commands return an ephemeral (only-to-invoker) result.
 */
export async function invokeCommand(input: InvokeCommandInput): Promise<CommandResult> {
  const definition = BUILTIN_COMMANDS.find((c) => c.name === input.name);
  if (!definition) throw Errors.NOT_FOUND(undefined, `Unknown command: ${input.name}`);

  const channel = await requireChannelRow(input.channelId);
  const isDm = channel.guild_id === null;
  if (isDm && !definition.dmCapable) {
    throw Errors.VALIDATION_FAILED(undefined, "That command cannot be used in direct messages.");
  }

  const access = await assertChannelAccess(input.channelId, input.userId, Permissions.VIEW_CHANNEL);

  if (definition.permission && !isDm && channel.guild_id) {
    const ctx = await loadMemberContext(channel.guild_id, input.userId);
    const effective = ctx.basePermissions | access.permissions;
    if ((effective & definition.permission) !== definition.permission) {
      throw Errors.MISSING_PERMISSIONS({ command: input.name });
    }
  }

  const reply = (content: string, ephemeral = true): CommandResult => ({
    command: input.name,
    invocationId: input.invocationId ?? null,
    content,
    ephemeral,
  });

  switch (input.name) {
    case "ping":
      return reply(`Pong! \`${Date.now() % 1000}ms\``);

    case "help": {
      const list = BUILTIN_COMMANDS.map((c) => `**/${c.name}** — ${c.description}`).join("\n");
      return reply(`Available commands:\n${list}`);
    }

    case "shrug": {
      const text = input.args.text ? `${input.args.text} ` : "";
      await postCommandMessage(input.channelId, input.userId, `${text}¯\\_(ツ)_/¯`);
      return reply("", false);
    }

    case "me": {
      const text = String(input.args.text ?? "").slice(0, 1000);
      if (!text) throw Errors.VALIDATION_FAILED({ field: "text" });
      await postCommandMessage(input.channelId, input.userId, `_${text}_`);
      return reply("", false);
    }

    case "user": {
      const raw = String(input.args.user ?? input.userId);
      const targetId = raw.replace(/[<@!>]/g, "") || input.userId;
      const user = await queryOne<{ username: string; display_name: string | null; id: string; created_at: Date }>(
        `SELECT id, username, display_name, created_at FROM users WHERE id = $1`,
        [targetId],
      );
      if (!user) throw Errors.UNKNOWN_USER();
      return reply(
        `**${user.display_name ?? user.username}** (@${user.username})\nID: \`${user.id}\`\nJoined: ${user.created_at.toISOString()}`,
      );
    }

    case "server": {
      if (isDm || !channel.guild_id) throw Errors.VALIDATION_FAILED(undefined, "Not in a server.");
      const guild = await queryOne<{ name: string; id: string; created_at: Date; owner_id: string }>(
        `SELECT id, name, owner_id, created_at FROM guilds WHERE id = $1`,
        [channel.guild_id],
      );
      const members = await queryOne<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM guild_members WHERE guild_id = $1`,
        [channel.guild_id],
      );
      if (!guild) throw Errors.UNKNOWN_GUILD();
      return reply(
        `**${guild.name}**\nID: \`${guild.id}\`\nMembers: ${members?.count ?? "0"}\nCreated: ${guild.created_at.toISOString()}`,
      );
    }

    case "nick": {
      if (isDm || !channel.guild_id) throw Errors.VALIDATION_FAILED(undefined, "Not in a server.");
      const nickname = String(input.args.nickname ?? "").trim().slice(0, 32);
      const { setMemberNickname } = await import("./moderation.js");
      await setMemberNickname(channel.guild_id, input.userId, input.userId, nickname || null);
      return reply(`Nickname updated to **${nickname}**.`);
    }

    case "slowmode": {
      if (isDm || !channel.guild_id) throw Errors.VALIDATION_FAILED(undefined, "Not in a server.");
      const seconds = Math.max(0, Math.min(Number(input.args.seconds ?? 0), 21600));
      const { updateChannel } = await import("./channels.js");
      await updateChannel(channel.guild_id, input.channelId, input.userId, { rateLimitPerUser: seconds });
      return reply(seconds === 0 ? "Slowmode disabled." : `Slowmode set to ${seconds}s.`);
    }

    case "timeout": {
      if (isDm || !channel.guild_id) throw Errors.VALIDATION_FAILED(undefined, "Not in a server.");
      const raw = String(input.args.user ?? "").replace(/[<@!>]/g, "");
      if (!raw) throw Errors.VALIDATION_FAILED({ field: "user" });
      const seconds = Math.max(0, Math.min(Number(input.args.seconds ?? 60), 28 * 24 * 3600));
      const result = await timeoutMember(
        channel.guild_id,
        raw,
        input.userId,
        seconds,
        input.args.reason ? String(input.args.reason) : null,
      );
      return reply(`Timed out <@${raw}> until ${result.timeoutUntil}.`);
    }

    default:
      throw Errors.NOT_FOUND(undefined, `Unknown command: ${input.name}`);
  }
}

async function postCommandMessage(channelId: string, userId: string, content: string): Promise<void> {
  await createMessage({ channelId, authorId: userId, content });
}

/** Emit an ephemeral interaction result to the invoking user only. */
export function emitInteractionResult(userId: string, result: CommandResult): void {
  bus().toUser(userId, ServerEvents.INTERACTION_RESULT, result);
}

export { MessageType };
