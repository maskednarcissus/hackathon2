import type { FastifyInstance, FastifyReply } from 'fastify';
import { ZodError } from 'zod';

export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function sendError(reply: FastifyReply, err: HttpError): FastifyReply {
  return reply.status(err.statusCode).send({
    error: {
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    },
  });
}

/** `map` lets the service translate its own error types (e.g. upstream failures) into HttpErrors. */
export function installErrorHandler(
  app: FastifyInstance,
  map?: (err: unknown) => HttpError | null,
): void {
  app.setErrorHandler((err, _req, reply) => {
    const mapped = map?.(err);
    if (mapped) return sendError(reply, mapped);
    if (err instanceof HttpError) return sendError(reply, err);
    if (err instanceof ZodError) {
      return sendError(
        reply,
        new HttpError(400, 'validation_error', 'Request validation failed', err.issues),
      );
    }
    const e = err as { statusCode?: number; message?: string };
    if (typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500) {
      return sendError(
        reply,
        new HttpError(e.statusCode, 'bad_request', e.message ?? 'Bad request'),
      );
    }
    app.log.error(err);
    return sendError(reply, new HttpError(500, 'internal_error', 'Internal server error'));
  });
  app.setNotFoundHandler((req, reply) =>
    sendError(reply, new HttpError(404, 'not_found', `Route ${req.method} ${req.url} not found`)),
  );
}
