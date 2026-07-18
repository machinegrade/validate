/**
 * Typed HTTP-level errors.
 *
 * Every error the API returns to a client is one of these — no free-form
 * error strings. Shape on the wire: { code, message, hint, docs_url }.
 */

export type ErrorCode =
  | "INVALID_KEY"
  | "LIMIT_EXCEEDED"
  | "UNSUPPORTED_TYPE"
  | "MALFORMED_INPUT"
  | "RATE_LIMITED";

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  INVALID_KEY: 401,
  LIMIT_EXCEEDED: 402,
  UNSUPPORTED_TYPE: 400,
  MALFORMED_INPUT: 400,
  RATE_LIMITED: 429,
};

const DOCS_BASE = "/openapi.yaml";

export interface TypedErrorBody {
  code: ErrorCode;
  message: string;
  hint: string;
  docs_url: string;
}

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly hint: string;
  readonly docs_url: string;

  constructor(code: ErrorCode, message: string, hint: string, docs_url = DOCS_BASE) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.hint = hint;
    this.docs_url = docs_url;
  }

  toBody(): TypedErrorBody {
    return {
      code: this.code,
      message: this.message,
      hint: this.hint,
      docs_url: this.docs_url,
    };
  }
}

export function invalidKeyError(): ApiError {
  return new ApiError(
    "INVALID_KEY",
    "The X-Api-Key header is missing or does not match a known key.",
    "Issue a key with POST /keys and pass it as the X-Api-Key header.",
    "/openapi.yaml#/paths/~1keys"
  );
}

export function limitExceededError(limit: number): ApiError {
  return new ApiError(
    "LIMIT_EXCEEDED",
    `Free tier limit of ${limit} calls/month exceeded for this key.`,
    "Request paid access via POST /v1/paid-request, see pricing in GET /v1/manifest.",
    "/v1/manifest#pricing"
  );
}

export function unsupportedTypeError(type: string, supported: string[]): ApiError {
  return new ApiError(
    "UNSUPPORTED_TYPE",
    `Validator type "${type}" is not supported.`,
    `Use one of: ${supported.join(", ")}.`,
    "/v1/manifest#types"
  );
}

export function malformedInputError(message: string, hint: string): ApiError {
  return new ApiError("MALFORMED_INPUT", message, hint, "/openapi.yaml#/paths/~1v1~1validate");
}

export function rateLimitedError(perMinute: number): ApiError {
  return new ApiError(
    "RATE_LIMITED",
    `Rate limit of ${perMinute} calls/minute exceeded for this key.`,
    "Slow down requests and retry after a short backoff.",
    "/v1/manifest#limits"
  );
}
