import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { ZodError } from "zod";
import crypto from "crypto";

/**
 * Structured error response returned by the API.
 * Every error follows this shape so clients can parse errors uniformly.
 */
interface ApiErrorResponse {
  error: string;
  code: string;
  statusCode: number;
  requestId: string;
  details?: Record<string, string[]>;
  timestamp: string;
}

/**
 * Map of known error codes to HTTP status codes and default messages.
 * Route handlers can throw an Error whose `message` matches a key here
 * to get a consistent status code without calling reply.status() themselves.
 */
const ERROR_CODE_MAP: Record<string, { statusCode: number; code: string }> = {
  VALIDATION_ERROR:     { statusCode: 400, code: "VALIDATION_ERROR" },
  NOT_FOUND:            { statusCode: 404, code: "NOT_FOUND" },
  UNAUTHORIZED:         { statusCode: 401, code: "UNAUTHORIZED" },
  FORBIDDEN:            { statusCode: 403, code: "FORBIDDEN" },
  RATE_LIMITED:         { statusCode: 429, code: "RATE_LIMITED" },
  INTERNAL_ERROR:       { statusCode: 500, code: "INTERNAL_ERROR" },
  SERVICE_UNAVAILABLE:  { statusCode: 503, code: "SERVICE_UNAVAILABLE" },
};

/**
 * Format ZodError into a human-readable field → messages map.
 *
 * Example output:
 * ```json
 * { "userAddress": ["Must be exactly 56 characters"], "amount": ["Must be a positive number"] }
 * ```
 */
function formatZodError(error: ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : "_root";
    if (!fieldErrors[path]) {
      fieldErrors[path] = [];
    }
    fieldErrors[path].push(issue.message);
  }

  return fieldErrors;
}

/**
 * Register centralized error handling on a Fastify instance.
 *
 * What this does:
 * 1. Assigns a unique `X-Request-Id` to every request (or reuses one from the client).
 * 2. Catches all unhandled errors thrown from route handlers and formats them
 *    into a consistent `ApiErrorResponse` shape.
 * 3. Gives Zod validation errors a 400 status with per-field details.
 * 4. Returns a clean 404 for unknown routes instead of Fastify's default HTML.
 */
export function registerErrorHandling(fastify: FastifyInstance): void {
  // ── Request ID ──────────────────────────────────────────────────────────
  fastify.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    const existing = request.headers["x-request-id"];
    const requestId = typeof existing === "string" && existing.length > 0
      ? existing
      : crypto.randomUUID();

    // Attach to request for downstream use and echo back in the response
    (request as FastifyRequest & { requestId: string }).requestId = requestId;
    reply.header("X-Request-Id", requestId);
  });

  // ── Centralized error handler ───────────────────────────────────────────
  fastify.setErrorHandler((error, request, reply) => {
    const requestId =
      (request as FastifyRequest & { requestId?: string }).requestId ??
      crypto.randomUUID();

    // Zod validation errors → 400 with field-level details
    if (error instanceof ZodError) {
      const response: ApiErrorResponse = {
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        statusCode: 400,
        requestId,
        details: formatZodError(error),
        timestamp: new Date().toISOString(),
      };
      return reply.status(400).send(response);
    }

    // Fastify wraps Zod errors in its own error object sometimes
    if (error.validation || (error as any).cause instanceof ZodError) {
      const zodErr = (error as any).cause as ZodError | undefined;
      const response: ApiErrorResponse = {
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        statusCode: 400,
        requestId,
        details: zodErr ? formatZodError(zodErr) : undefined,
        timestamp: new Date().toISOString(),
      };
      return reply.status(400).send(response);
    }

    // Rate limit errors from @fastify/rate-limit
    if (error.statusCode === 429) {
      const response: ApiErrorResponse = {
        error: "Too many requests. Please slow down.",
        code: "RATE_LIMITED",
        statusCode: 429,
        requestId,
        timestamp: new Date().toISOString(),
      };
      return reply.status(429).send(response);
    }

    // Known error codes
    const mapped = ERROR_CODE_MAP[error.message];
    if (mapped) {
      const response: ApiErrorResponse = {
        error: error.message,
        code: mapped.code,
        statusCode: mapped.statusCode,
        requestId,
        timestamp: new Date().toISOString(),
      };
      return reply.status(mapped.statusCode).send(response);
    }

    // Determine status code: use Fastify's statusCode if set, else 500
    const statusCode = error.statusCode && error.statusCode >= 400
      ? error.statusCode
      : 500;

    // For 5xx errors, log the full stack trace but don't leak it to the client
    if (statusCode >= 500) {
      fastify.log.error(
        { err: error, requestId, url: request.url, method: request.method },
        "Unhandled server error"
      );
    }

    const response: ApiErrorResponse = {
      error: statusCode >= 500
        ? "An internal error occurred. Please try again later."
        : error.message,
      code: statusCode >= 500 ? "INTERNAL_ERROR" : "REQUEST_ERROR",
      statusCode,
      requestId,
      timestamp: new Date().toISOString(),
    };

    return reply.status(statusCode).send(response);
  });

  // ── 404 handler ─────────────────────────────────────────────────────────
  fastify.setNotFoundHandler((request, reply) => {
    const requestId =
      (request as FastifyRequest & { requestId?: string }).requestId ??
      crypto.randomUUID();

    const response: ApiErrorResponse = {
      error: `Route ${request.method} ${request.url} not found`,
      code: "NOT_FOUND",
      statusCode: 404,
      requestId,
      timestamp: new Date().toISOString(),
    };

    reply.status(404).send(response);
  });
}
