import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

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

  SMTP_URL: z.string().optional(),
});

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
  if (problems.length > 0) {
    // eslint-disable-next-line no-console
    console.error(`Refusing to start in production:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    process.exit(1);
  }
}
