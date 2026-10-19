/**
 * Tagged error algebra. The server maps these to HTTP status codes and a stable
 * `code` string; clients may branch on `code` without parsing messages.
 */

export interface NebulaErrorShape {
  code: string;
  message: string;
  /** HTTP status when surfaced over REST. */
  status: number;
  details?: Record<string, unknown>;
}

export class NebulaError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(shape: NebulaErrorShape) {
    super(shape.message);
    this.name = "NebulaError";
    this.code = shape.code;
    this.status = shape.status;
    this.details = shape.details;
  }
}

type ErrorFactory = (details?: Record<string, unknown>, message?: string) => NebulaError;

const make = (code: string, status: number, defaultMessage: string): ErrorFactory =>
  (details, message) => new NebulaError({ code, status, message: message ?? defaultMessage, details });

export const Errors = {
  // 400
  VALIDATION_FAILED: make("VALIDATION_FAILED", 400, "Request validation failed."),
  INVALID_JSON: make("INVALID_JSON", 400, "Request body was not valid JSON."),
  INVALID_SNOWFLAKE: make("INVALID_SNOWFLAKE", 400, "A provided id was not a valid snowflake."),
  CANNOT_DM_SELF: make("CANNOT_DM_SELF", 400, "You cannot open a direct message with yourself."),
  CANNOT_FRIEND_SELF: make("CANNOT_FRIEND_SELF", 400, "You cannot add yourself as a friend."),
  NAME_INVALID: make("NAME_INVALID", 400, "That name is not allowed."),
  MESSAGE_TOO_LONG: make("MESSAGE_TOO_LONG", 400, "Message content exceeds the maximum length."),
  MESSAGE_EMPTY: make("MESSAGE_EMPTY", 400, "A message must contain content, attachments or an embed."),
  SLOWMODE_ACTIVE: make("SLOWMODE_ACTIVE", 429, "You are sending messages too quickly."),
  HIERARCHY_VIOLATION: make("HIERARCHY_VIOLATION", 403, "You cannot act on a member or role at or above your highest role."),
  UNSUPPORTED_CHANNEL_TYPE: make("UNSUPPORTED_CHANNEL_TYPE", 400, "This operation is not supported for that channel type."),

  // 401
  UNAUTHENTICATED: make("UNAUTHENTICATED", 401, "You must be signed in."),
  INVALID_CREDENTIALS: make("INVALID_CREDENTIALS", 401, "Invalid username or password."),
  SESSION_EXPIRED: make("SESSION_EXPIRED", 401, "Your session has expired. Please sign in again."),
  INVALID_CSRF: make("INVALID_CSRF", 403, "CSRF token missing or invalid."),

  // 403
  FORBIDDEN: make("FORBIDDEN", 403, "You do not have permission to do that."),
  MISSING_PERMISSIONS: make("MISSING_PERMISSIONS", 403, "You are missing a required permission."),
  NOT_GUILD_MEMBER: make("NOT_GUILD_MEMBER", 403, "You are not a member of that guild."),
  CHANNEL_NOT_ACCESSIBLE: make("CHANNEL_NOT_ACCESSIBLE", 403, "You cannot access that channel."),
  BLOCKED: make("BLOCKED", 403, "This interaction is blocked by a privacy setting."),
  ACCOUNT_SUSPENDED: make("ACCOUNT_SUSPENDED", 403, "This account is suspended."),

  // 404
  NOT_FOUND: make("NOT_FOUND", 404, "The requested resource was not found."),
  UNKNOWN_USER: make("UNKNOWN_USER", 404, "Unknown user."),
  UNKNOWN_GUILD: make("UNKNOWN_GUILD", 404, "Unknown guild."),
  UNKNOWN_CHANNEL: make("UNKNOWN_CHANNEL", 404, "Unknown channel."),
  UNKNOWN_MESSAGE: make("UNKNOWN_MESSAGE", 404, "Unknown message."),
  UNKNOWN_ROLE: make("UNKNOWN_ROLE", 404, "Unknown role."),
  UNKNOWN_INVITE: make("UNKNOWN_INVITE", 404, "Unknown or expired invite."),
  UNKNOWN_ATTACHMENT: make("UNKNOWN_ATTACHMENT", 404, "Unknown attachment."),

  // Account security (milestone 1)
  TOKEN_INVALID: make("TOKEN_INVALID", 400, "This link is invalid or has expired."),
  EMAIL_NOT_SET: make("EMAIL_NOT_SET", 400, "This account has no email address on file."),
  INVALID_MFA_CODE: make("INVALID_MFA_CODE", 400, "That authentication code is not valid."),
  MFA_NOT_ENROLLED: make("MFA_NOT_ENROLLED", 409, "Two-factor authentication is not enabled on this account."),
  MFA_ALREADY_ENABLED: make("MFA_ALREADY_ENABLED", 409, "Two-factor authentication is already enabled."),
  MFA_ENROLLMENT_PENDING: make("MFA_ENROLLMENT_PENDING", 409, "Finish or abandon the pending enrollment first."),
  MAIL_NOT_CONFIGURED: make("MAIL_NOT_CONFIGURED", 503, "Email delivery is not configured on this server."),

  // 409
  CONFLICT: make("CONFLICT", 409, "That action conflicts with existing state."),
  ALREADY_FRIENDS: make("ALREADY_FRIENDS", 409, "You are already friends with that user."),
  ALREADY_MEMBER: make("ALREADY_MEMBER", 409, "You are already a member of that guild."),
  ALREADY_BLOCKED: make("ALREADY_BLOCKED", 409, "That user is already blocked."),
  TARGET_BLOCKED_YOU: make("TARGET_BLOCKED_YOU", 403, "You cannot interact with that user."),
  TARGET_BLOCKED_BY_YOU: make("TARGET_BLOCKED_BY_YOU", 403, "You have blocked that user."),
  LAST_OWNER: make("LAST_OWNER", 409, "A guild must retain at least one owner."),

  // 413 / 415
  PAYLOAD_TOO_LARGE: make("PAYLOAD_TOO_LARGE", 413, "The upload exceeds the maximum allowed size."),
  UNSUPPORTED_MEDIA_TYPE: make("UNSUPPORTED_MEDIA_TYPE", 415, "That file type is not allowed."),
  QUOTA_EXCEEDED: make("QUOTA_EXCEEDED", 413, "The guild storage quota has been exceeded."),

  // 429
  RATE_LIMITED: make("RATE_LIMITED", 429, "You are being rate limited."),

  // 500
  INTERNAL: make("INTERNAL", 500, "An internal error occurred."),
  UPSTREAM_UNAVAILABLE: make("UPSTREAM_UNAVAILABLE", 503, "A dependency is unavailable."),
} as const;

export type NebulaErrorCode = keyof typeof Errors;

export function isNebulaError(value: unknown): value is NebulaError {
  return value instanceof NebulaError;
}

/** Wrap an unknown thrown value as a NebulaError (internal by default). */
export function toNebulaError(value: unknown): NebulaError {
  if (isNebulaError(value)) return value;
  const message = value instanceof Error ? value.message : "An internal error occurred.";
  return new NebulaError({ code: "INTERNAL", status: 500, message });
}
