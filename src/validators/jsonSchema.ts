/**
 * type: "json_schema" — validate `artifact` against `contract.schema`,
 * collecting all errors (not just the first).
 *
 * Uses @cfworker/json-schema (a pure-interpreter validator) rather than ajv:
 * ajv compiles schemas via `new Function(...)` at call time, which the
 * Cloudflare Workers runtime disallows, and `contract.schema` arrives
 * dynamically per request (from the caller), so it can't be precompiled at
 * build time either.
 */
import { Validator, type OutputUnit } from "@cfworker/json-schema";
import { malformedInputError } from "../errors.js";
import type { Verdict, VerdictError, ValidatorInput } from "./common.js";

export function validateJsonSchema(input: ValidatorInput): Verdict {
  const start = performance.now();
  const contract = input.contract as { schema?: unknown } | undefined;

  if (!contract || typeof contract !== "object" || contract.schema === undefined) {
    throw malformedInputError(
      'contract.schema is required for type "json_schema".',
      "Pass contract: { schema: <JSON Schema object> } alongside the artifact."
    );
  }

  let validator: Validator;
  try {
    validator = new Validator(contract.schema as Record<string, unknown>, "2019-09", false);
  } catch (err) {
    throw malformedInputError(
      `contract.schema is not a valid JSON Schema: ${(err as Error).message}`,
      "Fix the JSON Schema in contract.schema and resubmit."
    );
  }

  const result = validator.validate(input.artifact);
  const errors: VerdictError[] = result.errors.map(toVerdictError);

  return {
    valid: result.valid,
    errors,
    latency_ms: elapsed(start),
  };
}

function elapsed(start: number): number {
  return Math.max(0, Math.round(performance.now() - start));
}

function toVerdictError(err: OutputUnit): VerdictError {
  const path = err.instanceLocation.replace(/^#/, "") || "/";
  return {
    path,
    code: err.keyword,
    message: err.error,
    fix_hint: `Fix "${err.error}" at ${path}.`,
  };
}
