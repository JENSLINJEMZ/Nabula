import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyInstance } from "fastify";
import { env, isProduction } from "../config.js";
import { logger } from "../logger.js";
import { attachSession, enforceCsrf } from "./auth.js";
import { registerErrorHandling } from "./errors.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerChannelRoutes } from "./routes/channels.js";
import { registerGuildRoutes } from "./routes/guilds.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerMiscRoutes } from "./routes/misc.js";
import { registerUserRoutes } from "./routes/users.js";

/**
 * Build the HTTP application.
 *
 * Security posture:
 *  - `@fastify/helmet` sets hardening headers; the API serves only JSON and media,
 *    so a `default-src 'none'` CSP is appropriate and safe.
 *  - CORS is locked to the configured web origin and allows credentials (cookies).
 *  - Cookies are HttpOnly (session) plus a readable CSRF companion.
 *  - A global rate limit applies; authentication endpoints get a stricter one.
 */
export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    trustProxy: false,
    bodyLimit: env.MAX_UPLOAD_BYTES + 1024 * 1024,
    ajv: { customOptions: { removeAdditional: false } },
  });

  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    // Media (avatars, attachments) is fetched cross-origin by the SPA.
    crossOriginResourcePolicy: { policy: "cross-origin" },
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: "no-referrer" },
    hsts: isProduction ? { maxAge: 15552000, includeSubDomains: true, preload: false } : false,
  });

  await app.register(cors, {
    origin: [env.PUBLIC_WEB_ORIGIN],
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "x-csrf-token"],
    maxAge: 600,
  });

  await app.register(cookie, {
    secret: env.SESSION_SECRET,
    parseOptions: { sameSite: "lax", path: "/" },
  });

  await app.register(multipart, {
    limits: { fileSize: env.MAX_UPLOAD_BYTES, files: 1, fields: 10 },
    throwFileSizeLimit: true,
  });

  if (!env.RATE_LIMIT_DISABLED) {
    await app.register(rateLimit, {
      global: true,
      max: env.RATE_LIMIT_MAX,
      timeWindow: "1 minute",
      keyGenerator: (request) => request.auth?.userId ?? request.ip,
      allowList: [],
      // Return a real Error carrying the status/code so the app's error handler
      // surfaces it as a 429 RATE_LIMITED instead of a 500.
      errorResponseBuilder: () => {
        const error = new Error(
          "You are sending requests too quickly. Please slow down.",
        ) as Error & { statusCode?: number; code?: string };
        error.statusCode = 429;
        error.code = "RATE_LIMITED";
        return error;
      },
    });
  }

  // Session resolution must precede CSRF enforcement.
  app.addHook("onRequest", attachSession);
  app.addHook("onRequest", enforceCsrf);

  app.addHook("onResponse", (request, reply, done) => {
    if (reply.statusCode >= 400) {
      logger.debug("request completed", {
        method: request.method,
        url: request.url,
        status: reply.statusCode,
        userId: request.auth?.userId ?? null,
      });
    }
    done();
  });

  registerErrorHandling(app);

  await app.register(registerAuthRoutes);
  await app.register(registerUserRoutes);
  await app.register(registerGuildRoutes);
  await app.register(registerChannelRoutes);
  await app.register(registerMessageRoutes);
  await app.register(registerMiscRoutes);

  return app;
}
