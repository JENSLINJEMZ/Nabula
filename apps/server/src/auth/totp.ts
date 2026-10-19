import { generateSecret, generateSync, generateURI, verifySync } from "otplib";
import * as qrcode from "qrcode";

/**
 * TOTP (RFC 6238) helpers built on `otplib` v13's functional API.
 *
 * Secrets are Base32 (Google-Authenticator compatible). Codes are 6 digits on a
 * 30 s step with SHA-1, the interoperable default. Verification accepts a
 * ±30 s (one-step) tolerance to absorb clock skew between the server and the
 * user's authenticator app, and uses the library's constant-time comparison.
 */
const EPOCH_TOLERANCE_SECONDS = 30;

export function generateTotpSecret(): string {
  return generateSecret();
}

export function getTotpUri(secret: string, username: string, issuer = "Nebula"): string {
  return generateURI({ issuer, label: username, secret });
}

export async function generateQrCodeDataUrl(uri: string): Promise<string> {
  return qrcode.toDataURL(uri);
}

export function verifyTotpCode(secret: string, token: string): boolean {
  if (!/^\d{6}$/.test(token)) return false;
  try {
    return verifySync({ secret, token, epochTolerance: EPOCH_TOLERANCE_SECONDS }).valid;
  } catch {
    return false;
  }
}
