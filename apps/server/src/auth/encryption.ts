import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "../config.js";

/**
 * Symmetric encryption for TOTP secrets at rest (AES-256-GCM).
 *
 * The key is derived from the dedicated `TOTP_ENCRYPTION_KEY` environment
 * secret (never `SESSION_SECRET`) via SHA-256, so any passphrase of sufficient
 * entropy works without enforcing a byte-exact encoding. The IV is random per
 * value; the auth tag travels with the ciphertext.
 *
 * Stored format: base64(iv[12] || tag[16] || ciphertext).
 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function key(): Buffer {
  return createHash("sha256").update(env.TOTP_ENCRYPTION_KEY, "utf8").digest();
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

export function decryptSecret(encoded: string): string {
  const buf = Buffer.from(encoded, "base64");
  if (buf.length < IV_LENGTH + TAG_LENGTH) throw new Error("Malformed ciphertext");
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = buf.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
