import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** An error that is safe to show to API clients. */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly options: { headers?: Record<string, string>; details?: unknown } = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function errorResponse(c: Context, error: ApiError): Response {
  const body = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.options.details === undefined ? {} : { details: error.options.details }),
    },
  };
  return c.json(body, error.status, error.options.headers);
}

/** Hono `onError` handler: known errors pass through, anything else becomes an opaque 500. */
export function handleError(err: Error, c: Context): Response {
  if (err instanceof ApiError) return errorResponse(c, err);
  console.error("Unhandled error", err);
  return errorResponse(c, new ApiError(500, "internal_error", "Something went wrong on our side."));
}
