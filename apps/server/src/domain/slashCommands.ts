import {
  Errors,
  MessageType,
  Permissions,
  ServerEvents,
  type Command,
  type CommandResult,
  type Message as WireMessage,
} from "@nebula/shared";
import { nextId } from "../ids.js";
import { execute, query, queryOne } from "../db/pool.js";
import { bus } from "../realtime/bus.js";
import { requireChannelRow } from "./channels.js";
import type { ChannelRowFull } from "./mappers.js";
import { addReaction, createMessage } from "./messages.js";
import { assertChannelAccess, loadMemberContext } from "./permissions.js";
import { timeoutMember } from "./moderation.js";

/**
 * First-party application + built-in slash commands.
 *
 * This is intentionally an in-process command implementation rather than a
 * third-party bot/OAuth platform: it covers interaction plumbing (registration,
 * permission gating, argument validation, invocation, response) without
 * pretending to be a full developer platform. The registry below is the single
 * source of truth for command metadata; handlers are looked up by name so new
 * commands are additive.
 */

export const BUILTIN_APPLICATION_NAME = "Nebula";

/** Command option types (a subset of Discord's application command option types). */
export const CommandOptionType = {
  STRING: 3,
  INTEGER: 4,
  USER: 6,
} as const;

export interface CommandOption {
  name: string;
  description: string;
  type: number;
  required?: boolean;
  choices?: string[];
  /** Example value rendered as an argument hint in the composer. */
  example?: string;
}

export interface CommandDefinition {
  name: string;
  description: string;
  /** Usage string, e.g. `/me <text>`. */
  usage: string;
  options: CommandOption[];
  /** Permission required to invoke (checked against effective channel permissions). */
  permission?: bigint;
  /** Whether the command may be used in DMs. */
  dmCapable?: boolean;
  /** True when invoking the command posts a normal channel message. */
  posts?: boolean;
}

export const BUILTIN_COMMANDS: CommandDefinition[] = [
  { name: "ping", description: "Check the gateway latency.", usage: "/ping", options: [], dmCapable: true },
  { name: "help", description: "List the available commands.", usage: "/help", options: [], dmCapable: true },
  {
    name: "shrug",
    description: "Append a shrug to your message.",
    usage: "/shrug [text]",
    options: [{ name: "text", description: "Optional text", type: CommandOptionType.STRING, example: "whatever" }],
    dmCapable: true,
    posts: true,
  },
  {
    name: "me",
    description: "Send an action message.",
    usage: "/me <text>",
    options: [{ name: "text", description: "The action", type: CommandOptionType.STRING, required: true, example: "waves" }],
    dmCapable: true,
    posts: true,
  },
  {
    name: "user",
    description: "Show information about a user.",
    usage: "/user [user]",
    options: [{ name: "user", description: "User mention or id", type: CommandOptionType.USER }],
    dmCapable: true,
  },
  {
    name: "server",
    description: "Show information about this server.",
    usage: "/server",
    options: [],
    permission: Permissions.VIEW_CHANNEL,
  },
  {
    name: "nick",
    description: "Change your nickname in this server.",
    usage: "/nick <nickname>",
    options: [
      { name: "nickname", description: "The new nickname (omit to clear)", type: CommandOptionType.STRING, required: true },
    ],
    permission: Permissions.CHANGE_NICKNAME,
  },
  {
    name: "slowmode",
    description: "Set the channel slowmode in seconds.",
    usage: "/slowmode <seconds>",
    options: [
      {
        name: "seconds",
        description: "Seconds between messages (0 disables)",
        type: CommandOptionType.INTEGER,
        required: true,
        example: "5",
      },
    ],
    permission: Permissions.MANAGE_CHANNELS,
  },
  {
    name: "timeout",
    description: "Time out a member.",
    usage: "/timeout <user> <seconds> [reason]",
    options: [
      { name: "user", description: "The member to time out", type: CommandOptionType.USER, required: true },
      { name: "seconds", description: "Duration in seconds", type: CommandOptionType.INTEGER, required: true, example: "600" },
      { name: "reason", description: "Reason", type: CommandOptionType.STRING },
    ],
    permission: Permissions.MODERATE_MEMBERS,
  },
  {
    name: "poll",
    description: "Create a poll; members vote by reacting.",
    usage: "/poll <question> | <choice> | <choice>",
    options: [
      {
        name: "text",
        description: "Question and choices separated by | (2-10 choices)",
        type: CommandOptionType.STRING,
        required: true,
        example: "Best pet? | Cats | Dogs",
      },
    ],
    posts: true,
  },
  {
    name: "topic",
    description: "Show or update the channel topic.",
    usage: "/topic [text]",
    options: [{ name: "text", description: "New topic (use `clear` to remove)", type: CommandOptionType.STRING }],
    posts: false,
  },
];

const COMMAND_BY_NAME = new Map(BUILTIN_COMMANDS.map((c) => [c.name, c]));

/** Poll emoji progression; index aligns with the choice position. */
const POLL_EMOJIS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣", "🔟"] as const;
const POLL_MAX_CHOICES = POLL_EMOJIS.length;

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
    application =
      inserted ??
      (await queryOne<{ id: string }>(`SELECT id FROM applications WHERE name = $1 AND owner_id IS NULL LIMIT 1`, [
        BUILTIN_APPLICATION_NAME,
      ]));
  }
  if (!application) throw Errors.INTERNAL(undefined, "Failed to bootstrap built-in application");

  for (const command of BUILTIN_COMMANDS) {
    // Keep description/options fresh across releases while preserving the id.
    await execute(
      `INSERT INTO slash_commands (id, application_id, guild_id, name, description, options)
       VALUES ($1, $2, NULL, $3, $4, $5::jsonb)
       ON CONFLICT (application_id, name) WHERE guild_id IS NULL
       DO UPDATE SET description = EXCLUDED.description, options = EXCLUDED.options`,
      [
        nextId(),
        application.id,
        command.name,
        command.description,
        JSON.stringify(
          command.options.map((o) => ({
            name: o.name,
            description: o.description,
            type: o.type,
            required: o.required ?? false,
            choices: o.choices,
          })),
        ),
      ],
    );
  }
}

/** Command metadata as exposed to clients (mirrors the in-process registry). */
export async function listCommands(guildId?: string | null): Promise<unknown[]> {
  const rows = await query<{ id: string; name: string; guild_id: string | null }>(
    `SELECT id, name, guild_id FROM slash_commands
      WHERE guild_id IS NULL ${guildId ? "OR guild_id = $1" : ""}`,
    guildId ? [guildId] : [],
  );
  const idByName = new Map(rows.filter((r) => r.guild_id === null).map((r) => [r.name, r.id]));
  return BUILTIN_COMMANDS.map((definition) => ({
    id: idByName.get(definition.name) ?? definition.name,
    name: definition.name,
    description: definition.description,
    usage: definition.usage,
    options: definition.options.map((o) => ({
      name: o.name,
      description: o.description,
      type: o.type,
      required: o.required ?? false,
      ...(o.choices ? { choices: o.choices } : {}),
      ...(o.example ? { example: o.example } : {}),
    })),
    dmCapable: definition.dmCapable ?? false,
    ephemeral: !definition.posts,
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

interface CommandContext {
  definition: CommandDefinition;
  channel: ChannelRowFull;
  isDm: boolean;
  userId: string;
  args: Record<string, string | number>;
  /** Effective channel permissions (0n in DMs). */
  effectivePermissions: bigint;
  reply: (content: string, ephemeral?: boolean) => CommandResult;
  post: (content: string) => Promise<{ id: string }>;
}

type CommandHandler = (ctx: CommandContext) => Promise<CommandResult>;

/**
 * Split a raw command line into a name and whitespace/quote-aware tokens.
 * Returns null when the input is not a command.
 */
function tokenize(body: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const char of body) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
}

/**
 * Map positional tokens onto a command's declared options. A trailing string
 * option consumes the remaining tokens so `/me waves at everyone` works.
 */
function mapPositional(definition: CommandDefinition, positional: string[]): Record<string, string> {
  const args: Record<string, string> = {};
  let index = 0;
  for (let i = 0; i < definition.options.length && index < positional.length; i++) {
    const option = definition.options[i];
    if (!option) break;
    const isLast = i === definition.options.length - 1;
    if (isLast && option.type === CommandOptionType.STRING) {
      args[option.name] = positional.slice(index).join(" ");
      index = positional.length;
    } else {
      args[option.name] = positional[index] ?? "";
      index += 1;
    }
  }
  return args;
}

/** Parse `/name args…` into a command name and option record. */
export function parseCommandContent(content: string): { name: string; args: Record<string, string> } {
  const trimmed = content.trim();
  if (!trimmed.startsWith("/")) throw Errors.VALIDATION_FAILED({ field: "content" }, "Commands must start with '/'.");
  const tokens = tokenize(trimmed.slice(1));
  const name = tokens[0];
  if (!name) throw Errors.VALIDATION_FAILED({ field: "content" }, "Missing command name.");
  const normalized = name.toLowerCase();
  const definition = BUILTIN_COMMANDS.find((c) => c.name === normalized);
  if (!definition) throw Errors.NOT_FOUND({ command: normalized }, `Unknown command: /${normalized}`);
  return { name: normalized, args: mapPositional(definition, tokens.slice(1)) };
}

/** Validate and coerce caller-supplied arguments against the registry metadata. */
function coerceArgs(
  definition: CommandDefinition,
  raw: Record<string, string | number | undefined>,
): Record<string, string | number> {
  const known = new Set(definition.options.map((o) => o.name));
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) throw Errors.VALIDATION_FAILED({ field: key }, `Unknown argument: ${key}`);
  }

  const args: Record<string, string | number> = {};
  for (const option of definition.options) {
    const value = raw[option.name];
    if (value === undefined || value === null || value === "") {
      if (option.required) {
        throw Errors.VALIDATION_FAILED(
          { field: option.name, usage: definition.usage },
          `Missing required argument: ${option.name}. Usage: ${definition.usage}`,
        );
      }
      continue;
    }
    if (option.type === CommandOptionType.INTEGER) {
      const num = Number(value);
      if (!Number.isFinite(num) || !Number.isInteger(num)) {
        throw Errors.VALIDATION_FAILED({ field: option.name }, `${option.name} must be an integer.`);
      }
      args[option.name] = num;
      continue;
    }
    const str = String(value);
    if (option.choices && !option.choices.includes(str)) {
      throw Errors.VALIDATION_FAILED(
        { field: option.name },
        `${option.name} must be one of: ${option.choices.join(", ")}.`,
      );
    }
    args[option.name] = str;
  }
  return args;
}

// --------------------------------------------------------------------- handlers

const HANDLERS: Record<string, CommandHandler> = {
  ping: async (ctx) => ctx.reply(`Pong! \`${Date.now() % 1000}ms\``),

  help: async (ctx) => {
    const usable = BUILTIN_COMMANDS.filter((command) => {
      if (!command.permission) return true;
      if (ctx.isDm) return command.dmCapable === true;
      return (ctx.effectivePermissions & command.permission) === command.permission;
    });
    const list = usable.map((c) => `**${c.usage}** — ${c.description}`).join("\n");
    return ctx.reply(`Available commands:\n${list}`);
  },

  shrug: async (ctx) => {
    const text = ctx.args.text ? `${ctx.args.text} ` : "";
    await ctx.post(`${text}¯\\_(ツ)_/¯`);
    return ctx.reply("", false);
  },

  me: async (ctx) => {
    const text = String(ctx.args.text ?? "").slice(0, 1000);
    if (!text) throw Errors.VALIDATION_FAILED({ field: "text", usage: "/me <text>" }, "Provide the action text.");
    await ctx.post(`_${text}_`);
    return ctx.reply("", false);
  },

  user: async (ctx) => {
    const raw = String(ctx.args.user ?? ctx.userId);
    const targetId = raw.replace(/[<@!>]/g, "") || ctx.userId;
    const user = await queryOne<{ username: string; display_name: string | null; id: string; created_at: Date }>(
      `SELECT id, username, display_name, created_at FROM users WHERE id = $1`,
      [targetId],
    );
    if (!user) throw Errors.UNKNOWN_USER();
    return ctx.reply(
      `**${user.display_name ?? user.username}** (@${user.username})\nID: \`${user.id}\`\nJoined: ${user.created_at.toISOString()}`,
    );
  },

  server: async (ctx) => {
    if (ctx.isDm || !ctx.channel.guild_id) throw Errors.VALIDATION_FAILED(undefined, "Not in a server.");
    const guild = await queryOne<{ name: string; id: string; created_at: Date; owner_id: string }>(
      `SELECT id, name, owner_id, created_at FROM guilds WHERE id = $1`,
      [ctx.channel.guild_id],
    );
    const members = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM guild_members WHERE guild_id = $1`,
      [ctx.channel.guild_id],
    );
    if (!guild) throw Errors.UNKNOWN_GUILD();
    return ctx.reply(
      `**${guild.name}**\nID: \`${guild.id}\`\nMembers: ${members?.count ?? "0"}\nCreated: ${guild.created_at.toISOString()}`,
    );
  },

  nick: async (ctx) => {
    if (ctx.isDm || !ctx.channel.guild_id) throw Errors.VALIDATION_FAILED(undefined, "Not in a server.");
    const nickname = String(ctx.args.nickname ?? "").trim().slice(0, 32);
    const { setMemberNickname } = await import("./moderation.js");
    await setMemberNickname(ctx.channel.guild_id, ctx.userId, ctx.userId, nickname || null);
    return ctx.reply(nickname ? `Nickname updated to **${nickname}**.` : "Nickname cleared.");
  },

  slowmode: async (ctx) => {
    if (ctx.isDm || !ctx.channel.guild_id) throw Errors.VALIDATION_FAILED(undefined, "Not in a server.");
    const seconds = Math.max(0, Math.min(Number(ctx.args.seconds ?? 0), 21600));
    const { updateChannel } = await import("./channels.js");
    await updateChannel(ctx.channel.guild_id, ctx.channel.id, ctx.userId, { rateLimitPerUser: seconds });
    return ctx.reply(seconds === 0 ? "Slowmode disabled." : `Slowmode set to ${seconds}s.`);
  },

  timeout: async (ctx) => {
    if (ctx.isDm || !ctx.channel.guild_id) throw Errors.VALIDATION_FAILED(undefined, "Not in a server.");
    const raw = String(ctx.args.user ?? "").replace(/[<@!>]/g, "");
    if (!raw) throw Errors.VALIDATION_FAILED({ field: "user", usage: "/timeout <user> <seconds> [reason]" }, "Provide a member.");
    const seconds = Math.max(0, Math.min(Number(ctx.args.seconds ?? 60), 28 * 24 * 3600));
    const result = await timeoutMember(
      ctx.channel.guild_id,
      raw,
      ctx.userId,
      seconds,
      ctx.args.reason ? String(ctx.args.reason) : null,
    );
    return ctx.reply(`Timed out <@${raw}> until ${result.timeoutUntil}.`);
  },

  poll: async (ctx) => {
    const raw = String(ctx.args.text ?? "");
    const parts = raw
      .split("|")
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length < 3) {
      throw Errors.VALIDATION_FAILED(
        { field: "text", usage: "/poll <question> | <choice> | <choice>" },
        "Provide a question and at least two choices separated by |.",
      );
    }
    const question = (parts[0] ?? "").slice(0, 256);
    const choices = parts.slice(1, POLL_MAX_CHOICES + 1);
    const lines = choices
      .map((choice, i) => `${POLL_EMOJIS[i] ?? "•"} ${choice.slice(0, 200)}`)
      .join("\n");
    const message = await ctx.post(`**${question}**\n${lines}`);
    // Seed the vote reactions as the invoker. A missing ADD_REACTIONS permission
    // must not fail the whole command — the poll itself is already posted.
    for (let i = 0; i < choices.length; i++) {
      const emoji = POLL_EMOJIS[i];
      if (emoji) await addReaction(message.id, ctx.userId, emoji).catch(() => undefined);
    }
    return ctx.reply("", false);
  },

  topic: async (ctx) => {
    if (ctx.isDm || !ctx.channel.guild_id) throw Errors.VALIDATION_FAILED(undefined, "Not in a server.");
    const text = ctx.args.text === undefined ? undefined : String(ctx.args.text);
    if (text === undefined) {
      const topic = ctx.channel.topic ?? null;
      return ctx.reply(topic ? `Channel topic: ${topic}` : "This channel has no topic.");
    }
    if ((ctx.effectivePermissions & Permissions.MANAGE_CHANNELS) !== Permissions.MANAGE_CHANNELS) {
      throw Errors.MISSING_PERMISSIONS({ permission: "MANAGE_CHANNELS" });
    }
    const clearing = text.toLowerCase() === "clear";
    const { updateChannel } = await import("./channels.js");
    await updateChannel(ctx.channel.guild_id, ctx.channel.id, ctx.userId, {
      topic: clearing ? null : text.slice(0, 1024),
    });
    return ctx.reply(clearing ? "Channel topic cleared." : "Channel topic updated.");
  },
};

// -------------------------------------------------------------- safety valves

/** Sliding-window invocation limit per user (defence in depth on top of HTTP limits). */
const INVOKE_WINDOW_MS = 10_000;
const INVOKE_MAX_PER_WINDOW = 20;
const invocationTimes = new Map<string, number[]>();

function assertNotRateLimited(userId: string): void {
  const now = Date.now();
  const recent = (invocationTimes.get(userId) ?? []).filter((t) => now - t < INVOKE_WINDOW_MS);
  if (recent.length >= INVOKE_MAX_PER_WINDOW) {
    invocationTimes.set(userId, recent);
    throw Errors.RATE_LIMITED({ retryAfterMs: INVOKE_WINDOW_MS - (now - (recent[0] ?? now)) });
  }
  recent.push(now);
  invocationTimes.set(userId, recent);
}

/** Recently executed invocation results, keyed by invoker, for replay safety. */
const INVOCATION_TTL_MS = 5 * 60_000;
const INVOCATION_CACHE_MAX = 5_000;
const invocationCache = new Map<string, { result: CommandResult; at: number }>();

function cacheKey(input: InvokeCommandInput): string | null {
  return input.invocationId ? `${input.userId}:${input.channelId}:${input.invocationId}` : null;
}

/**
 * Invoke a built-in command. Content commands post a normal message; informational
 * commands return an ephemeral (only-to-invoker) result.
 *
 * Replays carrying the same `invocationId` return the original result without
 * re-executing, so a retried request cannot post a duplicate message.
 */
export async function invokeCommand(input: InvokeCommandInput): Promise<CommandResult> {
  const definition = BUILTIN_COMMANDS.find((c) => c.name === input.name);
  if (!definition) throw Errors.NOT_FOUND({ command: input.name }, `Unknown command: /${input.name}`);

  const key = cacheKey(input);
  if (key) {
    const cached = invocationCache.get(key);
    if (cached && Date.now() - cached.at < INVOCATION_TTL_MS) return cached.result;
  }

  assertNotRateLimited(input.userId);

  const channel = await requireChannelRow(input.channelId);
  const isDm = channel.guild_id === null;
  if (isDm && !definition.dmCapable) {
    throw Errors.VALIDATION_FAILED(undefined, "That command cannot be used in direct messages.");
  }

  const access = await assertChannelAccess(input.channelId, input.userId, Permissions.VIEW_CHANNEL);
  let effectivePermissions = 0n;
  if (!isDm && channel.guild_id) {
    const ctx = await loadMemberContext(channel.guild_id, input.userId);
    effectivePermissions = ctx.basePermissions | access.permissions;
    if (definition.permission && (effectivePermissions & definition.permission) !== definition.permission) {
      throw Errors.MISSING_PERMISSIONS({ command: input.name, permission: String(definition.permission) });
    }
  }

  const args = coerceArgs(definition, input.args);
  const handler = HANDLERS[definition.name];
  if (!handler) throw Errors.INTERNAL({ command: definition.name }, "Command has no handler.");

  const reply = (content: string, ephemeral = true): CommandResult => ({
    command: definition.name,
    invocationId: input.invocationId ?? null,
    channelId: input.channelId,
    content,
    ephemeral,
  });

  const ctx: CommandContext = {
    definition,
    channel,
    isDm,
    userId: input.userId,
    args,
    effectivePermissions,
    reply,
    post: async (content: string) => {
      const message = await createMessage({ channelId: input.channelId, authorId: input.userId, content });
      return { id: message.id };
    },
  };

  const result = await handler(ctx);
  if (key) {
    if (invocationCache.size >= INVOCATION_CACHE_MAX) {
      const oldest = invocationCache.keys().next().value;
      if (oldest !== undefined) invocationCache.delete(oldest);
    }
    invocationCache.set(key, { result, at: Date.now() });
  }
  return result;
}

/** Emit an ephemeral interaction result to the invoking user only. */
export function emitInteractionResult(userId: string, result: CommandResult): void {
  bus().toUser(userId, ServerEvents.INTERACTION_RESULT, result);
}

export { MessageType };
