import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

/**
 * Treat an unset or blank value as absent, so `VAR=` deliberately disables a
 * setting (e.g. `SMTP_URL=` switches email off) instead of failing validation.
 */
function blankToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

const optionalString = z.preprocess(blankToUndefined, z.string().optional());

/**
 * Environment schema. Fail fast and loudly on invalid configuration rather than
 * limping along with undefined values. Secrets are required in production.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  HOST: z.string().default("0.0.0.0"),
  PUBLIC_WEB_ORIGIN: z.string().default("http://localhost:5173"),

  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  REDIS_URL: z.string().optional(),

  SESSION_SECRET: z.string().min(16, "SESSION_SECRET must be at least 16 characters"),
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),

  STORAGE_DRIVER: z.enum(["local"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./data/uploads"),
  MAX_UPLOAD_BYTES: z.coerce.number().int().positive().default(26_214_400),
  STORAGE_QUOTA_BYTES_PER_GUILD: z.coerce.number().int().positive().default(1_073_741_824),

  RATE_LIMIT_DISABLED: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  // Global per-user (or per-IP) request budget per minute. The e2e suite raises
  // this for local test runs; production keeps the 600 default.
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),

  // Outbound email (verification / password reset). Optional: when no relay is
  // configured the mail-sending endpoints fail safely with MAIL_NOT_CONFIGURED
  // instead of pretending an email was sent. In development/test, emails are
  // captured to disk (see mail/mailer.ts) instead of being sent.
  //
  // The relay can be described either as a single URL …
  //   SMTP_URL=smtp://user:pass@host:587
  // … or with discrete variables for providers that hand those out separately:
  //   SMTP_HOST=host  SMTP_PORT=587  SMTP_USER=user  SMTP_PASS=pass
  // Precedence is resolved by `resolveSmtpSettings()` below. An empty value
  // counts as unset everywhere, so `SMTP_URL=` turns email delivery off.
  SMTP_URL: z.preprocess(
    blankToUndefined,
    z.string().url("SMTP_URL must be a URL such as smtp://user:pass@host:587").optional(),
  ),
  SMTP_HOST: optionalString,
  SMTP_PORT: z.preprocess(
    blankToUndefined,
    z.coerce.number().int().min(1).max(65535).optional(),
  ),
  SMTP_USER: optionalString,
  SMTP_PASS: optionalString,
  SMTP_FROM: z.string().default("Nebula <no-reply@nebula.local>"),
  // Directory that development/test email captures are written to (eml files).
  MAIL_DEV_DIR: z.string().default("./data/mail"),

  // Dedicated encryption key for TOTP secrets at rest. Required in every
  // environment and deliberately separate from SESSION_SECRET.
  TOTP_ENCRYPTION_KEY: z
    .string()
    .min(32, "TOTP_ENCRYPTION_KEY must be at least 32 characters")
    .refine((v) => v !== process.env.SESSION_SECRET, {
      message: "TOTP_ENCRYPTION_KEY must differ from SESSION_SECRET",
    }),
});

export const APP_URL = process.env.APP_URL ?? process.env.PUBLIC_WEB_ORIGIN ?? "http://localhost:5173";

export type Env = z.infer<typeof EnvSchema>;

function parseEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    // eslint-disable-next-line no-console
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = parseEnv();

/** Connection details for the outbound SMTP relay, resolved from the env. */
export type SmtpSettings = {
  host: string;
  port: number;
  /** Implicit TLS (`smtps://`, or plain `smtp://` on port 465); otherwise STARTTLS. */
  secure: boolean;
  user?: string;
  pass?: string;
};

/**
 * Resolve the outbound SMTP relay from either configuration style:
 *
 *  - `SMTP_URL` alone (`smtp://user:pass@host:587`), or
 *  - `SMTP_HOST` (+ `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`) alone.
 *
 * When both are present `SMTP_URL` decides host/port/protocol (it is the
 * documented single-value form) and the discrete `SMTP_USER`/`SMTP_PASS` supply
 * credentials only if the URL carries none — so a URL can be paired with
 * credentials kept in separate variables.
 *
 * Returns `null` when no relay is configured; the mailer then captures to disk
 * in development/test and answers `MAIL_NOT_CONFIGURED` in production.
 * The result can contain the SMTP password: never log it.
 */
export function resolveSmtpSettings(
  input: Pick<Env, "SMTP_URL" | "SMTP_HOST" | "SMTP_PORT" | "SMTP_USER" | "SMTP_PASS"> = env,
): SmtpSettings | null {
  const fromUrl = input.SMTP_URL ? new URL(input.SMTP_URL) : null;
  const host = fromUrl?.hostname || input.SMTP_HOST;
  if (!host) return null;

  const implicitTls = fromUrl?.protocol === "smtps:";
  const port = fromUrl?.port
    ? Number(fromUrl.port)
    : (input.SMTP_PORT ?? (implicitTls ? 465 : 587));
  const user = fromUrl?.username ? decodeURIComponent(fromUrl.username) : input.SMTP_USER;
  const pass = fromUrl?.password ? decodeURIComponent(fromUrl.password) : input.SMTP_PASS;

  return { host, port, secure: implicitTls || port === 465, user, pass };
}

export const smtpSettings = resolveSmtpSettings();
export const smtpConfigured = smtpSettings !== null;

export const isProduction = env.NODE_ENV === "production";
export const isTest = env.NODE_ENV === "test";

/**
 * In production, refuse to boot with placeholder secrets or insecure cookies.
 * This prevents a misconfigured deploy from silently accepting forged sessions.
 */
if (isProduction) {
  const problems: string[] = [];
  if (env.SESSION_SECRET.includes("change-me")) problems.push("SESSION_SECRET is still the example value");
  if (env.SESSION_SECRET.length < 32) problems.push("SESSION_SECRET should be at least 32 characters in production");
  if (!env.COOKIE_SECURE) problems.push("COOKIE_SECURE must be true in production");
  if (env.RATE_LIMIT_DISABLED) problems.push("RATE_LIMIT_DISABLED must be false in production");
  if (env.RATE_LIMIT_MAX > 100_000) problems.push("RATE_LIMIT_MAX is set so high that rate limiting is effectively disabled");
  if (env.TOTP_ENCRYPTION_KEY.length < 32) problems.push("TOTP_ENCRYPTION_KEY should be at least 32 characters in production");
  if (env.TOTP_ENCRYPTION_KEY.includes("change-me")) problems.push("TOTP_ENCRYPTION_KEY is still the example value");
  if (problems.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`Refusing to start in production:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
  if (!smtpConfigured) {
    // Not fatal: the deployment may deliberately not offer email flows, but the
    // affected endpoints will answer MAIL_NOT_CONFIGURED rather than lie.
    // eslint-disable-next-line no-console
    console.warn(
      "No SMTP relay is set (SMTP_URL, or SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS): email verification and password-reset emails cannot be sent (endpoints return MAIL_NOT_CONFIGURED).",
    );
  }
}

// Credentials without a host are a common mistake; say so instead of silently
// treating mail as unconfigured. Checked in every environment (quiet in tests).
if (!isTest && !smtpConfigured && (env.SMTP_PORT !== undefined || env.SMTP_USER !== undefined || env.SMTP_PASS !== undefined)) {
  // eslint-disable-next-line no-console
  console.warn(
    "SMTP_PORT/SMTP_USER/SMTP_PASS are set but neither SMTP_HOST nor SMTP_URL is: no SMTP relay is configured and email will not be sent.",
  );
}
