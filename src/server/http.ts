import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ApiError } from "../shared/api.ts";

/** An error with an HTTP status and a message safe to show the user. */
export class HttpError extends Error {
  readonly statusCode: number;
  constructor(statusCode: number, message: string) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found.`);
export const badRequest = (message: string) => new HttpError(400, message);

/** Validate input with a schema; failures become a 400 with per-field issues. */
export function parse<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  return schema.parse(input);
}

export function idParam(params: unknown): number {
  const id = Number((params as { id?: string }).id);
  if (!Number.isInteger(id) || id <= 0) throw badRequest("Bad id.");
  return id;
}

export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) {
      const issues = error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
      const body: ApiError = { error: issues[0]?.message ?? "Invalid input.", issues };
      return reply.code(400).send(body);
    }
    if (error instanceof HttpError) {
      return reply.code(error.statusCode).send({ error: error.message } satisfies ApiError);
    }
    const status = (error as { statusCode?: number }).statusCode;
    if (status !== undefined && status >= 400 && status < 500) {
      return reply.code(status).send({ error: (error as Error).message } satisfies ApiError);
    }
    reply.log.error(error);
    return reply.code(500).send({ error: "Something went wrong on the server." } satisfies ApiError);
  });
}
