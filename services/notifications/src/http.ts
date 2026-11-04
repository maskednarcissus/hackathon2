import type { FastifyReply } from 'fastify';
import type { z } from 'zod';

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

export function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new HttpError(400, 'validation_error', 'Invalid request', result.error.flatten());
  }
  return result.data;
}

export const sendError = (reply: FastifyReply, err: HttpError): FastifyReply =>
  reply.status(err.statusCode).send({
    error: {
      code: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
    },
  });
