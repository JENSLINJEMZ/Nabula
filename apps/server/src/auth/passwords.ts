import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * Promise wrapper around the callback scrypt. Written explicitly (rather than
 * `util.promisify`) so the 5-argument options overload is preserved with correct
 * types.
 */
function scryptAsync(password: string, salt: Buffer, keylen: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, keylen, options, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey);
    });
  });
}

/**
 * Password hashing with scrypt.
 *
 * Choice: Node's built-in scrypt (RFC 7914) — no native build step, audited
 * implementation, and an OWASP-acceptable memory-hard KDF. Parameters follow
 * OWASP guidance (N=2^15, r=8, p=1). Argon2id would be a reasonable upgrade and
 * the `password_params` column exists so a migration path can be implemented
 * without invalidating existing hashes.
 *
 *   memory = 128 * N * r = 128 * 32768 * 8 = 32 MiB
 */
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
// scrypt needs slightly more than the theoretical 32 MiB; give it headroom.
const MAX_MEM = 64 * 1024 * 1024;

export const PASSWORD_PARAMS = `scrypt:N=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}`;

export interface PasswordHash {
  hash: string;
  salt: string;
  params: string;
}

/** Hash a plaintext password. Returns hex-encoded salt and derived key. */
export async function hashPassword(password: string): Promise<PasswordHash> {
  const salt = randomBytes(SALT_LENGTH);
  const derived = await scryptAsync(password.normalize("NFKC"), salt, KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: MAX_MEM,
  });
  return { hash: derived.toString("hex"), salt: salt.toString("hex"), params: PASSWORD_PARAMS };
}

/**
 * Verify a password against a stored hash using a constant-time comparison.
 * Returns false (never throws) on malformed input so it cannot be used as an
 * oracle.
 */
export async function verifyPassword(
  password: string,
  stored: { hash: string; salt: string },
): Promise<boolean> {
  try {
    const salt = Buffer.from(stored.salt, "hex");
    const expected = Buffer.from(stored.hash, "hex");
    if (salt.length === 0 || expected.length === 0) return false;
    const derived = await scryptAsync(password.normalize("NFKC"), salt, expected.length, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
      maxmem: MAX_MEM,
    });
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** Constant-time string comparison for tokens/secrets. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
