import { Errors } from "@nebula/shared";
import type { FastifyReply, FastifyRequest } from "fastify";
import { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE, resolveSession, verifyCsrf } from "../auth/sessions.js";

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Resolve the session for every request and attach it to `request.auth`.
 * Never throws — routes decide whether authentication is required.
 */
export async function attachSession(request: FastifyRequest): Promise<void> {
  request.auth = null;
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return;
  const resolved = await resolveSession(token);
  if (resolved) request.auth = { userId: resolved.userId, session: resolved.session };
}

/**
 * CSRF defence-in-depth: in addition to SameSite cookies, every mutating request
 * that carries a session must also present the session-bound CSRF token in the
 * `x-csrf-token` header (double-submit anchored to the server-side secret).
 *
 * Requests without a session are not subject to this check (login/register).
 */
export async function enforceCsrf(request: FastifyRequest): Promise<void> {
  if (!MUTATING_METHODS.has(request.method)) return;
  if (!request.auth) return;
  const header = request.headers[CSRF_HEADER];
  const token = Array.isArray(header) ? header[0] : header;
  await verifyCsrf(request.auth.session, token);
}

export async function requireAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.auth) throw Errors.UNAUTHENTICATED();
}

/** Assert the caller is authenticated and return the user id (narrowing helper). */
export function currentUserId(request: FastifyRequest): string {
  if (!request.auth) throw Errors.UNAUTHENTICATED();
  return request.auth.userId;
}

export { CSRF_COOKIE, CSRF_HEADER, SESSION_COOKIE };
