import type { FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { isNebulaError, type ApiErrorBody } from "@nebula/shared";
import { isProduction } from "../config.js";
import { logger } from "../logger.js";

/**
 * Centralised error handling. Every error is normalised to
 *   { error: { code, message, details? } }
 * so clients can branch on a stable `code`. Internal errors never leak stack
 * traces or SQL to the client in production.
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    const body: ApiErrorBody = {
      error: { code: "NOT_FOUND", message: `Route ${request.method} ${request.url} not found.` },
    };
    void reply.status(404).send(body);
  });

  app.setErrorHandler((error, request, reply) => {
    if (isNebulaError(error)) {
      const body: ApiErrorBody = {
        error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) },
      };
      void reply.status(error.status).send(body);
      return;
    }

    if (error instanceof ZodError) {
      const body: ApiErrorBody = {
        error: {
          code: "VALIDATION_FAILED",
          message: "Request validation failed.",
          details: {
            issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
          },
        },
      };
      void reply.status(400).send(body);
      return;
    }

    const normalized = error as { statusCode?: number; code?: string; message?: string; stack?: string };

    const status = typeof normalized.statusCode === "number" ? normalized.statusCode : 500;

    if (status >= 500) {
      logger.error("unhandled request error", {
        method: request.method,
        url: request.url,
        error: normalized.message ?? "unknown",
        stack: isProduction ? undefined : normalized.stack,
      });
    }

    const body: ApiErrorBody = {
      error: {
        code: status >= 500 ? "INTERNAL" : normalized.code ?? "REQUEST_FAILED",
        message:
          status >= 500 && isProduction
            ? "An internal error occurred."
            : normalized.message ?? "An internal error occurred.",
      },
    };
    void reply.status(status).send(body);
  });
}
