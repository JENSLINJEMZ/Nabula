import { Limits } from "./constants.js";
import { Errors } from "./errors.js";
import type { Embed, EmbedField } from "./types.js";

/**
 * Shared validation helpers. These are deliberately framework-free so the same
 * rules apply on the server (authoritative) and the client (early feedback).
 * The server NEVER trusts client-side validation.
 */

const USERNAME_FORBIDDEN_SUBSTRINGS = ["@", "#", ":", "```", "discord"];
const USERNAME_RESERVED = new Set(["everyone", "here"]);

/**
 * Normalize a username the way Discord documents: trim, and collapse runs of
 * whitespace. Returns null when the value is not a valid username.
 */
export function normalizeUsername(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length < Limits.USERNAME_MIN || collapsed.length > Limits.USERNAME_MAX) return null;
  const lower = collapsed.toLowerCase();
  if (USERNAME_RESERVED.has(lower)) return null;
  for (const sub of USERNAME_FORBIDDEN_SUBSTRINGS) {
    if (lower.includes(sub)) return null;
  }
  // Reject zero-width and other non-rendering control characters.
  if (/[\u0000-\u001f\u007f\u200b-\u200f\u2028\u2029\ufeff]/.test(collapsed)) return null;
  return collapsed;
}

export function normalizeDisplayName(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length < 1 || collapsed.length > Limits.DISPLAY_NAME_MAX) return null;
  if (/[\u0000-\u001f\u007f\u2028\u2029\ufeff]/.test(collapsed)) return null;
  return collapsed;
}

export interface PasswordStrength {
  ok: boolean;
  reason?: string;
}

export function validatePassword(password: string): PasswordStrength {
  if (password.length < Limits.PASSWORD_MIN) {
    return { ok: false, reason: `Password must be at least ${Limits.PASSWORD_MIN} characters.` };
  }
  if (password.length > Limits.PASSWORD_MAX) {
    return { ok: false, reason: `Password must be at most ${Limits.PASSWORD_MAX} characters.` };
  }
  // Deliberately permissive: encourage length over composition rules, but block
  // the most trivially guessable values.
  const lower = password.toLowerCase();
  const trivial = ["password", "12345678", "qwertyui", "letmein", "iloveyou", "admin123"];
  if (trivial.some((t) => lower.includes(t))) {
    return { ok: false, reason: "Password is too common." };
  }
  return { ok: true };
}

export function validateChannelName(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > Limits.CHANNEL_NAME_MAX) return null;
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return null;
  return trimmed;
}

export function validateGuildName(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (collapsed.length < Limits.GUILD_NAME_MIN || collapsed.length > Limits.GUILD_NAME_MAX) return null;
  if (/[\u0000-\u001f\u007f]/.test(collapsed)) return null;
  return collapsed;
}

/**
 * Discord-style mention parsing.
 *   <@123> / <@!123>  user
 *   <@&123>           role
 *   <#123>            channel
 *   @everyone / @here
 */
export interface ParsedMentions {
  userIds: string[];
  roleIds: string[];
  channelIds: string[];
  everyone: boolean;
  here: boolean;
}

const MENTION_RE = /<@!?(\d{1,20})>|<@&(\d{1,20})>|<#(\d{1,20})>|@everyone|@here/g;

export function parseMentions(content: string): ParsedMentions {
  const userIds = new Set<string>();
  const roleIds = new Set<string>();
  const channelIds = new Set<string>();
  let everyone = false;
  let here = false;

  for (const match of content.matchAll(MENTION_RE)) {
    if (match[0] === "@everyone") everyone = true;
    else if (match[0] === "@here") here = true;
    else if (match[1]) userIds.add(match[1]);
    else if (match[2]) roleIds.add(match[2]);
    else if (match[3]) channelIds.add(match[3]);
  }

  return {
    userIds: [...userIds],
    roleIds: [...roleIds],
    channelIds: [...channelIds],
    everyone,
    here,
  };
}

/** Escape HTML so message content is always rendered as text, never markup. */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

/** A guild slug-like discriminator (4 digits), for display parity with Discord tags. */
export function generateDiscriminator(): string {
  return String(Math.floor(Math.random() * 10000)).padStart(4, "0");
}

export function assertNever(value: never): never {
  throw Errors.INTERNAL({ value: String(value) }, `Unhandled variant: ${String(value)}`);
}

/**
 * Validate and normalize caller-supplied embeds.
 *
 * Embeds are *self-contained*: Nebula never dereferences `url` (which would be
 * an SSRF vector); the URL is stored as a plain link rendered by the client.
 * The normalizer caps the number of embeds, per-field lengths and total size,
 * and rejects non-http(s) URLs and malformed colors.
 */
export function normalizeEmbeds(input: unknown): { embeds: Embed[]; error: string | null } {
  try {
    return { embeds: parseEmbedsStrict(input), error: null };
  } catch (error) {
    return { embeds: [], error: error instanceof Error ? error.message : "Invalid embed." };
  }
}

const EMBED_FIELDS_MAX = 25;
const EMBED_URL_MAX = 2048;
const EMBED_FIELD_NAME_MAX = 256;
const EMBED_FIELD_VALUE_MAX = 1024;

function parseEmbedsStrict(input: unknown): Embed[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error("embeds must be an array.");
  if (input.length > Limits.EMBEDS_MAX_PER_MESSAGE) {
    throw new Error(`A message may contain at most ${Limits.EMBEDS_MAX_PER_MESSAGE} embeds.`);
  }

  let total = 0;
  const text = (value: unknown, max: number, field: string): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw new Error(`${field} must be a string.`);
    const trimmed = value.trim();
    if (trimmed.length > max) throw new Error(`${field} exceeds ${max} characters.`);
    total += trimmed.length;
    return trimmed || null;
  };

  const embeds: Embed[] = [];
  for (const raw of input) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error("Each embed must be an object.");
    }
    const embed = raw as Record<string, unknown>;
    const title = text(embed.title, Limits.EMBED_TITLE_MAX, "embed.title");
    const description = text(embed.description, Limits.EMBED_DESCRIPTION_MAX, "embed.description");
    const url = text(embed.url, EMBED_URL_MAX, "embed.url");
    if (url && !/^https?:\/\//i.test(url)) throw new Error("embed.url must be an http(s) URL.");

    let color: number | null = null;
    if (embed.color !== undefined && embed.color !== null) {
      if (
        typeof embed.color !== "number" ||
        !Number.isInteger(embed.color) ||
        embed.color < 0 ||
        embed.color > 0xffffff
      ) {
        throw new Error("embed.color must be an integer between 0 and 16777215.");
      }
      color = embed.color;
    }

    const fields: EmbedField[] = [];
    if (embed.fields !== undefined && embed.fields !== null) {
      if (!Array.isArray(embed.fields)) throw new Error("embed.fields must be an array.");
      if (embed.fields.length > EMBED_FIELDS_MAX) {
        throw new Error(`An embed may contain at most ${EMBED_FIELDS_MAX} fields.`);
      }
      for (const rawField of embed.fields) {
        if (typeof rawField !== "object" || rawField === null) {
          throw new Error("Each embed field must be an object.");
        }
        const field = rawField as Record<string, unknown>;
        const name = text(field.name, EMBED_FIELD_NAME_MAX, "embed field name");
        const value = text(field.value, EMBED_FIELD_VALUE_MAX, "embed field value");
        if (!name) throw new Error("Each embed field requires a name.");
        if (!value) throw new Error("Each embed field requires a value.");
        fields.push({ name, value, inline: field.inline === true });
      }
    }

    if (!title && !description && fields.length === 0) {
      throw new Error("An embed requires a title, a description, or at least one field.");
    }
    embeds.push({ title, description, url, color, fields });
  }

  if (total > Limits.EMBED_TOTAL_MAX) {
    throw new Error(`Embed content exceeds ${Limits.EMBED_TOTAL_MAX} characters in total.`);
  }
  return embeds;
}
