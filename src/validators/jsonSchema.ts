/**
 * type: "json_schema" — validate `artifact` against `contract.schema` using
 * ajv, collecting all errors (not just the first).
 */
import Ajv, { type ErrorObject } from "ajv";
import { malformedInputError } from "../errors.js";
import type { Verdict, VerdictError, ValidatorInput } from "./common.js";

const ajv = new Ajv({ allErrors: true, strict: false });

export function validateJsonSchema(input: ValidatorInput): Verdict {
  const start = performance.now();
  const contract = input.contract as { schema?: unknown } | undefined;

  if (!contract || typeof contract !== "object" || contract.schema === undefined) {
    throw malformedInputError(
      'contract.schema is required for type "json_schema".',
      "Pass contract: { schema: <JSON Schema object> } alongside the artifact."
    );
  }

  let validateFn;
  try {
    validateFn = ajv.compile(contract.schema as object);
  } catch (err) {
    throw malformedInputError(
      `contract.schema is not a valid JSON Schema: ${(err as Error).message}`,
      "Fix the JSON Schema in contract.schema and resubmit."
    );
  }

  const valid = validateFn(input.artifact);
  const errors: VerdictError[] = (validateFn.errors ?? []).map(toVerdictError);

  return {
    valid: !!valid,
    errors,
    latency_ms: elapsed(start),
  };
}

function elapsed(start: number): number {
  return Math.max(0, Math.round(performance.now() - start));
}

function toVerdictError(err: ErrorObject): VerdictError {
  const path = err.instancePath || "/";
  return {
    path,
    code: err.keyword,
    message: err.message ?? "validation error",
    fix_hint: buildFixHint(err),
  };
}

function buildFixHint(err: ErrorObject): string {
  const path = err.instancePath || "/";
  switch (err.keyword) {
    case "required": {
      const prop = (err.params as { missingProperty?: string }).missingProperty;
      return `Add required property "${prop}" at ${path}.`;
    }
    case "type": {
      const type = (err.params as { type?: string }).type;
      return `Change the value at ${path} to type "${type}".`;
    }
    case "enum": {
      const allowed = (err.params as { allowedValues?: unknown[] }).allowedValues ?? [];
      return `Use one of the allowed values [${allowed.join(", ")}] at ${path}.`;
    }
    case "additionalProperties": {
      const prop = (err.params as { additionalProperty?: string }).additionalProperty;
      return `Remove the unexpected property "${prop}" at ${path}.`;
    }
    case "format": {
      const format = (err.params as { format?: string }).format;
      return `Change the value at ${path} to match format "${format}".`;
    }
    default:
      return `Fix "${err.message}" at ${path}.`;
  }
}
