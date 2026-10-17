import type { GuildMember, Role } from "@nebula/shared";
import type { User } from "../store";

/** Deterministic accent colour per user, derived from the id. */
const AVATAR_COLORS = [
  "#6d5cff",
  "#37e0c0",
  "#ff5c72",
  "#ffb454",
  "#5c9dff",
  "#c05cff",
  "#4cd07d",
  "#ff8a5c",
];

export function avatarColor(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? "#6d5cff";
}

/** Join truthy class names. */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function initials(user: Pick<User, "username" | "displayName">): string {
  const source = (user.displayName || user.username || "?").trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] ?? "?").slice(0, 2).toUpperCase();
  return `${(parts[0] ?? "?").charAt(0)}${(parts[1] ?? "?").charAt(0)}`.toUpperCase();
}

export function displayName(user: Pick<User, "username" | "displayName">): string {
  return user.displayName || user.username;
}

/** A member's shown name: guild nickname > user display name > username. */
export function memberName(member: GuildMember): string {
  if (member.nickname) return member.nickname;
  if (member.user) return displayName(member.user);
  return member.userId.slice(-4);
}

/** Convert a 24-bit role colour to CSS, or null for the default role colour. */
export function roleColor(color: number | null | undefined): string | null {
  if (!color) return null;
  return `#${color.toString(16).padStart(6, "0")}`;
}

/** Highest hoisted role colour for a member (skips @everyone). */
export function memberColor(member: GuildMember, roles: Role[]): string | null {
  let best: { position: number; color: string } | null = null;
  for (const roleId of member.roles) {
    const role = roles.find((r) => r.id === roleId);
    if (!role || role.isEveryone || !role.color) continue;
    const color = roleColor(role.color);
    if (!color) continue;
    if (!best || role.position > best.position) best = { position: role.position, color };
  }
  return best?.color ?? null;
}

/** The member's highest role (by position), used for grouping/hoisting. */
export function topRole(member: GuildMember, roles: Role[]): Role | null {
  let best: Role | null = null;
  for (const roleId of member.roles) {
    const role = roles.find((r) => r.id === roleId);
    if (!role || role.isEveryone) continue;
    if (!best || role.position > best.position) best = role;
  }
  return best;
}

/** Group a channel list into text and voice sections. */
export function partitionChannels<T extends { type: number }>(channels: T[]): { text: T[]; voice: T[] } {
  const text: T[] = [];
  const voice: T[] = [];
  for (const c of channels) {
    // 2 = GUILD_VOICE, 13 = GUILD_STAGE_VOICE
    if (c.type === 2 || c.type === 13) voice.push(c);
    else text.push(c);
  }
  return { text, voice };
}

const PRESENCE_COLORS: Record<string, string> = {
  online: "#4cd07d",
  idle: "#ffb454",
  dnd: "#ff5c72",
  offline: "#6b7280",
};

export function presenceColor(status: string | undefined): string {
  return PRESENCE_COLORS[status ?? "offline"] ?? "#6b7280";
}

export function presenceLabel(status: string | undefined): string {
  switch (status) {
    case "online":
      return "Online";
    case "idle":
      return "Idle";
    case "dnd":
      return "Do Not Disturb";
    default:
      return "Offline";
  }
}

export function formatTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Today at ${time}`;
  return `${date.toLocaleDateString()} ${time}`;
}

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** Stable key for grouping messages by calendar day. */
export function dayKey(iso: string): string {
  return new Date(iso).toDateString();
}

export function formatDayDivider(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
}

export function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`;
}

/** Two messages belong to the same visual group when same author and <7 min apart. */
export function isSameGroup(a: { author: { id: string }; timestamp: string }, b: { author: { id: string }; timestamp: string }): boolean {
  if (a.author.id !== b.author.id) return false;
  return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime() < 7 * 60 * 1000;
}
