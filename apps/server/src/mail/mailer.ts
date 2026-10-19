import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import nodemailer, { type Transporter } from "nodemailer";
import { env, isProduction, smtpConfigured, smtpSettings } from "../config.js";
import { logger } from "../logger.js";

/**
 * Outbound email for account-security flows (verification, password reset).
 *
 * Delivery policy:
 *  - a relay is configured (`SMTP_URL`, or `SMTP_HOST` + `SMTP_PORT`/
 *    `SMTP_USER`/`SMTP_PASS`) → send through it with nodemailer.
 *  - no relay, dev/test         → capture each message as an `.eml` file under
 *    `MAIL_DEV_DIR`. This is the documented local-testing method: the E2E suite
 *    and integration tests read the captured file to obtain the link. The
 *    server log records only recipient + subject — never the body or token.
 *  - no relay, production       → throws MailNotConfiguredError; routes translate
 *    that into a MAIL_NOT_CONFIGURED response. We never pretend an email sent.
 */

export class MailNotConfiguredError extends Error {
  constructor() {
    super("No SMTP relay is configured (set SMTP_URL, or SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS); email cannot be sent.");
    this.name = "MailNotConfiguredError";
  }
}

export interface OutboundEmail {
  to: string;
  subject: string;
  text: string;
}

let transport: Transporter | null = null;

/**
 * Builds the SMTP transport from the resolved settings. The connection options
 * carry the SMTP password: never log them, never return them, never include
 * them in an error message.
 */
function getTransport(): Transporter {
  if (!transport) {
    const settings = smtpSettings;
    if (!settings) throw new MailNotConfiguredError();
    // `auth` is undefined (not omitted) when no credentials were supplied, so
    // the relay is contacted without attempting a login.
    transport = nodemailer.createTransport({
      host: settings.host,
      port: settings.port,
      secure: settings.secure,
      auth: settings.user !== undefined ? { user: settings.user, pass: settings.pass ?? "" } : undefined,
    });
  }
  return transport;
}

export async function sendEmail(email: OutboundEmail): Promise<void> {
  if (!smtpConfigured) {
    if (isProduction) throw new MailNotConfiguredError();
    await captureToDisk(email);
    return;
  }
  await getTransport().sendMail({
    from: env.SMTP_FROM,
    to: email.to,
    subject: email.subject,
    text: email.text,
  });
  // Log metadata only — bodies can contain single-use tokens.
  logger.info("email sent", { to: email.to, subject: email.subject });
}

async function captureToDisk(email: OutboundEmail): Promise<void> {
  const dir = env.MAIL_DEV_DIR;
  await mkdir(dir, { recursive: true });
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.eml`;
  const eml = [
    `From: ${env.SMTP_FROM}`,
    `To: ${email.to}`,
    `Subject: ${email.subject}`,
    `Date: ${new Date().toUTCString()}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    email.text,
  ].join("\r\n");
  await writeFile(join(dir, filename), eml, { mode: 0o600 });
  logger.info("email captured to disk (no SMTP configured)", { to: email.to, subject: email.subject, file: filename });
}

// ---- Email bodies ------------------------------------------------------------

export function verificationEmail(to: string, token: string, appUrl: string): OutboundEmail {
  return {
    to,
    subject: "Verify your Nebula email address",
    text: [
      "Welcome to Nebula!",
      "",
      "Confirm this email address by opening the link below (valid for 24 hours, single use):",
      "",
      `${appUrl}/verify-email?token=${encodeURIComponent(token)}`,
      "",
      "If you did not create this account you can ignore this message.",
    ].join("\n"),
  };
}

export function passwordResetEmail(to: string, token: string, appUrl: string): OutboundEmail {
  return {
    to,
    subject: "Reset your Nebula password",
    text: [
      "Someone requested a password reset for this Nebula account.",
      "",
      "Open the link below to choose a new password (valid for 1 hour, single use):",
      "",
      `${appUrl}/reset-password?token=${encodeURIComponent(token)}`,
      "",
      "If you did not request this, no action is needed — the password is unchanged.",
    ].join("\n"),
  };
}
