import type { SessionRow } from "../auth/sessions.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Populated by the authentication preHandler; null when unauthenticated. */
    auth: { userId: string; session: SessionRow } | null;
  }
}
