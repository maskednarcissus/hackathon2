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

export const conflict = (code: string, message: string, details?: unknown): AppError =>
  new AppError(409, code, message, details);

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError | ZodError, request, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'validation_error',
          message: 'Request validation failed',
          details: err.issues,
        },
      });
    }
    const status =
      typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) request.log.error(err);
    return reply.status(status).send({
      error: {
        code: status >= 500 ? 'internal_error' : (err.code ?? 'bad_request').toLowerCase(),
        message: status >= 500 ? 'Internal server error' : err.message,
      },
    });
  });
  app.setNotFoundHandler((request, reply) =>
    reply
      .status(404)
      .send({
        error: { code: 'route_not_found', message: `${request.method} ${request.url} not found` },
      }),
  );
}
