/**
 * Shared types for the pluggable validators. Kept in `validators/` (not a
 * new top-level module) since it's an implementation detail of the
 * validator layer only.
 */

export interface VerdictError {
  path: string;
  code: string;
  message: string;
  fix_hint: string;
}

export interface Verdict {
  valid: boolean;
  errors: VerdictError[];
  latency_ms: number;
}

export interface ValidatorInput {
  artifact: unknown;
  contract?: unknown;
}

export type ValidatorFn = (input: ValidatorInput) => Verdict | Promise<Verdict>;
