/**
 * type: "sql" — validate `artifact` (a SQL string) for syntax correctness
 * using node-sql-parser. contract = { dialect }.
 */
import { Parser } from "node-sql-parser";
import { malformedInputError } from "../errors.js";
import type { Verdict, VerdictError, ValidatorInput } from "./common.js";

const parser = new Parser();

interface SqlContract {
  dialect?: string;
}

/** node-sql-parser "database" option values, keyed by a friendlier dialect name. */
const DIALECT_MAP: Record<string, string> = {
  mysql: "MySQL",
  postgresql: "PostgresQL",
  postgres: "PostgresQL",
  sqlite: "SQLite",
  mariadb: "MariaDB",
  bigquery: "BigQuery",
  transactsql: "TransactSQL",
  tsql: "TransactSQL",
  snowflake: "Snowflake",
};

export function validateSql(input: ValidatorInput): Verdict {
  const start = performance.now();
  const contract = (input.contract ?? {}) as SqlContract;
  const dialectKey = (contract.dialect ?? "mysql").toLowerCase();
  const database = DIALECT_MAP[dialectKey];

  if (!database) {
    throw malformedInputError(
      `Unsupported SQL dialect "${contract.dialect}".`,
      `Set contract.dialect to one of: ${Object.keys(DIALECT_MAP).join(", ")}.`
    );
  }

  if (typeof input.artifact !== "string") {
    throw malformedInputError(
      'artifact must be a SQL string for type "sql".',
      "Pass the SQL statement to validate as a plain string in artifact."
    );
  }

  const errors: VerdictError[] = [];
  try {
    parser.astify(input.artifact, { database });
  } catch (err) {
    errors.push(toVerdictError(err));
  }

  return {
    valid: errors.length === 0,
    errors,
    latency_ms: Math.max(0, Math.round(performance.now() - start)),
  };
}

function toVerdictError(err: unknown): VerdictError {
  const message = err instanceof Error ? err.message : String(err);
  const location = (err as { location?: { start?: { line?: number; column?: number } } } | undefined)?.location;
  const start = location?.start;
  const path = start && start.line !== undefined ? `line:${start.line} col:${start.column}` : "/";

  return {
    path,
    code: "SQL_SYNTAX_ERROR",
    message,
    fix_hint: `Fix the SQL syntax near ${path === "/" ? "the reported location" : path}: ${message.split("\n")[0]}`,
  };
}
