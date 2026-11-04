import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError, type ZodType, type ZodTypeDef } from 'zod';

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

export const unauthorized = (
  message = 'Authentication required',
  code = 'unauthorized',
): AppError => new AppError(401, code, message);

export const forbidden = (message = 'Access denied', code = 'forbidden'): AppError =>
  new AppError(403, code, message);

export function parseOrThrow<T>(schema: ZodType<T, ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(400, 'validation_error', 'Request validation failed', result.error.issues);
  }
  return result.data;
}

interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

const body = (code: string, message: string, details?: unknown): ErrorBody =>
  details === undefined ? { error: { code, message } } : { error: { code, message, details } };

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | AppError | ZodError | Error, request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send(body(error.code, error.message, error.details));
    }
    if (error instanceof ZodError) {
      return reply
        .status(400)
        .send(body('validation_error', 'Request validation failed', error.issues));
    }
    const fastifyError = error as FastifyError;
    if (typeof fastifyError.statusCode === 'number' && fastifyError.statusCode < 500) {
      return reply
        .status(fastifyError.statusCode)
        .send(body(fastifyError.code ?? 'bad_request', fastifyError.message));
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.status(500).send(body('internal_error', 'Internal server error'));
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send(body('not_found', `Route ${request.method} ${request.url} not found`)),
  );
}
