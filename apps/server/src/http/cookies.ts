import type { FastifyReply } from "fastify";
import { env } from "../config.js";
import { CSRF_COOKIE, SESSION_COOKIE } from "./auth.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const base = {
  path: "/",
  sameSite: "lax" as const,
  secure: env.COOKIE_SECURE,
  domain: undefined as string | undefined,
};

/**
 * Issue the session cookie (HttpOnly, so it is unreadable to scripts) and a
 * companion CSRF cookie (readable by the app so it can echo the value back in a
 * header — the double-submit half of the CSRF defence).
 */
export function setSessionCookies(
  reply: FastifyReply,
  options: { token: string; csrfToken: string; expiresAt: Date },
): void {
  const maxAge = Math.max(1, Math.floor((options.expiresAt.getTime() - Date.now()) / 1000));
  reply.setCookie(SESSION_COOKIE, options.token, {
    ...base,
    httpOnly: true,
    maxAge,
    expires: options.expiresAt,
  });
  reply.setCookie(CSRF_COOKIE, options.csrfToken, {
    ...base,
    httpOnly: false,
    maxAge: Math.min(maxAge, 7 * 24 * 60 * 60),
    expires: new Date(Math.min(options.expiresAt.getTime(), Date.now() + 7 * DAY_MS)),
  });
}

export function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { ...base, httpOnly: true });
  reply.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false });
}
