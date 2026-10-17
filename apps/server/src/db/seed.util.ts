import { createHash } from "node:crypto";
import { queryOne } from "./pool.js";
import type { UserRow } from "../domain/mappers.js";

/**
 * Seed password policy:
 *  - If SEED_PASSWORD is set, use it (operator-controlled).
 *  - Otherwise derive a stable development password from SESSION_SECRET so it is
 *    reproducible but not a hard-coded credential in the repository.
 */
export function deriveSeedPassword(): string {
  const explicit = process.env.SEED_PASSWORD;
  if (explicit && explicit.length >= 10) return explicit;
  const digest = createHash("sha256").update(`${process.env.SESSION_SECRET ?? "nebula"}:seed`).digest("hex");
  return `Seed-${digest.slice(0, 20)}!9`;
}

export const forTesting = {
  async findUserByUsername(username: string): Promise<UserRow | null> {
    return queryOne<UserRow>(
      `SELECT id, username, discriminator, display_name, avatar_key, banner_key, accent_color, bio, bot,
              premium_type, email, email_verified, flags, created_at
         FROM users WHERE username_lower = $1`,
      [username.toLowerCase()],
    );
  },
};
