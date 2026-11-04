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
    const pgCode = (err as { code?: unknown; severity?: unknown }).severity
      ? (err as { code?: unknown }).code
      : undefined;
    if (pgCode === '23505' || pgCode === '23503' || pgCode === '22P02') {
      // Database constraint backstops (the service validates first; these cover races).
      const mapped =
        pgCode === '23505'
          ? { status: 409, code: 'conflict', message: 'Conflicting change; retry' }
          : pgCode === '23503'
            ? {
                status: 422,
                code: 'invalid_reference',
                message: 'Referenced record does not exist',
              }
            : { status: 400, code: 'invalid_value', message: 'Invalid identifier or value' };
      request.log.warn({ err }, 'database constraint rejected the request');
      return reply
        .status(mapped.status)
        .send({ error: { code: mapped.code, message: mapped.message } });
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
    reply.status(404).send({
      error: { code: 'route_not_found', message: `${request.method} ${request.url} not found` },
    }),
  );
}

export const unauthorized = (code: string, message: string): AppError =>
  new AppError(401, code, message);
export const forbidden = (code: string, message: string): AppError =>
  new AppError(403, code, message);
