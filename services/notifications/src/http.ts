import type { FastifyReply } from 'fastify';
import type { ZodTypeAny, z } from 'zod';

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

export function parse<S extends ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, 'validation_error', 'Invalid request', result.error.flatten());
  }
  return result.data as z.infer<S>;
}

export const sendError = (reply: FastifyReply, err: HttpError): FastifyReply =>
  reply.status(err.statusCode).send({
    error: {
      code: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    },
  });
