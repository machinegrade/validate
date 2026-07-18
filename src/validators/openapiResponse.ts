/**
 * type: "openapi_response" — validate `artifact` (a response body) against
 * the response schema found in an OpenAPI spec object.
 * contract = { spec, path, method, status }.
 *
 * Uses @cfworker/json-schema rather than ajv — see the comment in
 * jsonSchema.ts for why (ajv needs `new Function`, which Workers disallows,
 * and the response schema arrives dynamically per request).
 */
import { Validator } from "@cfworker/json-schema";
import { malformedInputError } from "../errors.js";
import type { Verdict, VerdictError, ValidatorInput } from "./common.js";

interface OpenApiResponseContract {
  spec: any;
  path: string;
  method: string;
  status: string | number;
}

export function validateOpenapiResponse(input: ValidatorInput): Verdict {
  const start = performance.now();
  const contract = input.contract as Partial<OpenApiResponseContract> | undefined;

  if (
    !contract ||
    typeof contract !== "object" ||
    !contract.spec ||
    typeof contract.path !== "string" ||
    typeof contract.method !== "string" ||
    contract.status === undefined
  ) {
    throw malformedInputError(
      'contract must be { spec, path, method, status } for type "openapi_response".',
      "Provide the full OpenAPI spec object plus contract.path, contract.method, and contract.status identifying the response to check against."
    );
  }

  const { spec, path, method, status } = contract as OpenApiResponseContract;
  const methodLower = String(method).toLowerCase();
  const statusKey = String(status);

  const pathItem = spec?.paths?.[path];
  if (!pathItem) {
    const known = Object.keys(spec?.paths ?? {});
    throw malformedInputError(
      `Path "${path}" was not found in the OpenAPI spec.`,
      known.length
        ? `Set contract.path to one of the paths defined in the spec, e.g. ${known.slice(0, 5).join(", ")}.`
        : "The OpenAPI spec has no paths defined; check contract.spec."
    );
  }

  const operation = pathItem[methodLower];
  if (!operation) {
    const known = Object.keys(pathItem).filter((k) => !k.startsWith("$") && !k.startsWith("x-"));
    throw malformedInputError(
      `Method "${method}" is not defined for path "${path}".`,
      known.length
        ? `Set contract.method to one of: ${known.join(", ")}.`
        : `No operations are defined under paths.${path} in the spec.`
    );
  }

  const response = operation?.responses?.[statusKey];
  if (!response) {
    const known = Object.keys(operation?.responses ?? {});
    throw malformedInputError(
      `Status "${status}" is not defined for ${String(method).toUpperCase()} ${path}.`,
      known.length
        ? `Set contract.status to one of: ${known.join(", ")}.`
        : `No responses are defined for ${String(method).toUpperCase()} ${path} in the spec.`
    );
  }

  const schema = response?.content?.["application/json"]?.schema;
  if (!schema) {
    throw malformedInputError(
      `No application/json response schema is defined for ${String(method).toUpperCase()} ${path} -> ${status}.`,
      "Add responses.<status>.content['application/json'].schema to that operation in the OpenAPI spec, or validate a different status/content type."
    );
  }

  let validator: Validator;
  try {
    validator = new Validator(schema as Record<string, unknown>, "2019-09", false);
  } catch (err) {
    throw malformedInputError(
      `Response schema is not a valid JSON Schema: ${(err as Error).message}`,
      "Fix the response schema in the OpenAPI spec and resubmit."
    );
  }

  const result = validator.validate(input.artifact);
  const errors: VerdictError[] = result.errors.map((err) => {
    const errPath = err.instanceLocation.replace(/^#/, "") || "/";
    return {
      path: errPath,
      code: err.keyword,
      message: err.error,
      fix_hint: `Fix "${err.error}" at ${errPath} to match the response schema for ${String(method).toUpperCase()} ${path} -> ${status}.`,
    };
  });

  return {
    valid: result.valid,
    errors,
    latency_ms: Math.max(0, Math.round(performance.now() - start)),
  };
}
