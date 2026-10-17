import { Limits } from "./constants.js";
import { Errors } from "./errors.js";

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
