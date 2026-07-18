/**
 * Core validate logic shared by POST /v1/validate (src/index.ts) and the
 * remote MCP "validate" tool (src/mcpServer.ts): type/artifact checks,
 * metering (auth.checkLimits), validator dispatch, and call telemetry.
 * Keeping this in one place is what makes the two entry points go through
 * the exact same limits/telemetry path rather than two parallel copies.
 */
import type { AuthService } from "./auth.js";
import { malformedInputError, unsupportedTypeError } from "./errors.js";
import type { KeyRecord, Storage } from "./storage.js";
import { recordCall } from "./telemetry.js";
import { validateJsonSchema } from "./validators/jsonSchema.js";
import { validateOpenapiResponse } from "./validators/openapiResponse.js";
import { validateSql } from "./validators/sql.js";
import type { Verdict, ValidatorInput } from "./validators/common.js";

export const VALIDATOR_TYPES = ["json_schema", "openapi_response", "sql"] as const;
export type ValidatorType = (typeof VALIDATOR_TYPES)[number];

const VALIDATORS: Record<ValidatorType, (input: ValidatorInput) => Verdict | Promise<Verdict>> = {
  json_schema: validateJsonSchema,
  openapi_response: validateOpenapiResponse,
  sql: validateSql,
};

export interface ValidateRequestBody {
  type?: unknown;
  artifact?: unknown;
  contract?: unknown;
}

/**
 * Run the type/artifact checks, enforce metering limits, dispatch to the
 * validator, and record the "call" telemetry event. Callers must have
 * already resolved `keyRecord` via `auth.requireKey` first.
 */
export async function processValidate(
  storage: Storage,
  auth: AuthService,
  keyRecord: KeyRecord,
  body: ValidateRequestBody
): Promise<{ verdict: Verdict; remaining: number }> {
  const type = body?.type;
  if (typeof type !== "string") {
    throw malformedInputError('"type" is required and must be a string.', `Set "type" to one of: ${VALIDATOR_TYPES.join(", ")}.`);
  }
  if (!(VALIDATOR_TYPES as readonly string[]).includes(type)) {
    throw unsupportedTypeError(type, [...VALIDATOR_TYPES]);
  }
  const hasArtifact = !!body && typeof body === "object" && "artifact" in body;
  if (!hasArtifact) {
    throw malformedInputError('"artifact" is required.', 'Include the artifact to validate as "artifact" in the request body.');
  }

  const { remaining } = await auth.checkLimits(keyRecord.key);

  const validatorFn = VALIDATORS[type as ValidatorType];
  const verdict = await validatorFn({ artifact: body.artifact, contract: body.contract });

  await recordCall(storage, keyRecord.key, type, verdict.valid, verdict.latency_ms);

  return { verdict, remaining };
}
