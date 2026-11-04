import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (resource: string, id: string): AppError =>
  new AppError(404, 'not_found', `${resource} ${id} not found`);

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

const body = (code: string, message: string, details?: unknown): ErrorBody =>
  details === undefined ? { error: { code, message } } : { error: { code, message, details } };

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError | ZodError, _req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send(body(err.code, err.message, err.details));
    }
    if (err instanceof ZodError) {
      return reply.status(400).send(body('validation_error', 'Invalid request', err.issues));
    }
    const status = err.statusCode ?? 500;
    if (status >= 500) {
      app.log.error(err);
      return reply.status(500).send(body('internal_error', 'Internal server error'));
    }
    return reply.status(status).send(body(err.code ?? 'bad_request', err.message));
  });
  app.setNotFoundHandler((req, reply) =>
    reply.status(404).send(body('route_not_found', `Route ${req.method} ${req.url} not found`)),
  );
}
