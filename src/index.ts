import { Hono } from "hono";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { AuthService, DEFAULT_AUTH_CONFIG, type AuthConfig } from "./auth.js";
import { ApiError, invalidKeyError, malformedInputError, unsupportedTypeError } from "./errors.js";
import { MemoryStorage, type Storage } from "./storage.js";
import { computeFunnel, recordCall, recordKeyIssued, recordPaidRequest } from "./telemetry.js";
import { validateJsonSchema } from "./validators/jsonSchema.js";
import { validateOpenapiResponse } from "./validators/openapiResponse.js";
import { validateSql } from "./validators/sql.js";
import type { Verdict, ValidatorInput } from "./validators/common.js";

// NOTE on Cloudflare Workers portability: GET /openapi.yaml and GET /llms.txt
// below read from the local filesystem (node:fs), which works for `npm run
// dev` and the test suite (both run on Node) but is a Node-only API. Actual
// `wrangler deploy` (phase P2, out of scope here — needs the owner's
// Cloudflare account) should switch these two routes to Workers Static
// Assets (an `[assets]` binding in wrangler.toml pointing at `public/`,
// with a copy of openapi.yaml alongside llms.txt) or inline the file
// contents as string constants at build time. Everything else in this file
// only uses Hono + the Storage interface, which are Workers-compatible.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

export const VALIDATOR_TYPES = ["json_schema", "openapi_response", "sql"] as const;
export type ValidatorType = (typeof VALIDATOR_TYPES)[number];

const VALIDATORS: Record<ValidatorType, (input: ValidatorInput) => Verdict | Promise<Verdict>> = {
  json_schema: validateJsonSchema,
  openapi_response: validateOpenapiResponse,
  sql: validateSql,
};

export interface Pricing {
  free_calls_per_month: number;
  paid_price_eur_per_call: number;
  paid_access: string;
}

export interface AppOptions {
  storage?: Storage;
  authConfig?: AuthConfig;
  adminToken?: string;
}

/**
 * Build a fresh Hono app instance. Exposed as a factory (rather than a
 * single module-level app) so tests can inject an isolated MemoryStorage
 * and a smaller monthlyLimit without waiting for 500 real requests.
 */
export function createApp(options: AppOptions = {}) {
  const storage: Storage = options.storage ?? new MemoryStorage();
  const authConfig: AuthConfig = options.authConfig ?? DEFAULT_AUTH_CONFIG;
  const adminToken = options.adminToken ?? process.env.ADMIN_TOKEN ?? "dev-admin";
  const auth = new AuthService(storage, authConfig);

  const pricing: Pricing = {
    free_calls_per_month: authConfig.monthlyLimit,
    paid_price_eur_per_call: 0.002,
    paid_access: "opens soon — request via POST /v1/paid-request",
  };

  const app = new Hono();

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(err.toBody(), err.status as 400 | 401 | 402 | 429);
    }
    console.error(err);
    return c.json(
      {
        code: "MALFORMED_INPUT" as const,
        message: "Unexpected server error while handling the request.",
        hint: "Check that the request body matches the documented shape.",
        docs_url: "/openapi.yaml",
      },
      400
    );
  });

  app.notFound((c) =>
    c.json(
      {
        code: "MALFORMED_INPUT" as const,
        message: "Not found.",
        hint: "Check the endpoint path against GET /openapi.yaml.",
        docs_url: "/openapi.yaml",
      },
      404
    )
  );

  async function parseJsonBody(c: any): Promise<any> {
    try {
      return await c.req.json();
    } catch {
      throw malformedInputError("Request body must be valid JSON.", "Send a JSON object with the documented fields as the request body.");
    }
  }

  // POST /keys { email } -> { key }
  app.post("/keys", async (c) => {
    const body = await parseJsonBody(c);
    const email = body?.email;
    if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw malformedInputError('"email" must be a valid email address string.', 'Send a body like {"email": "you@example.com"}.');
    }
    const key = await auth.issueKey(email);
    await recordKeyIssued(storage, key, email);
    return c.json({ key }, 201);
  });

  // POST /v1/validate { type, artifact, contract? }, header X-Api-Key
  app.post("/v1/validate", async (c) => {
    const keyRecord = await auth.requireKey(c.req.header("X-Api-Key"));
    const body = await parseJsonBody(c);

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

    c.header("X-Calls-Remaining", String(Math.max(remaining, 0)));
    return c.json(verdict, 200);
  });

  // GET /v1/manifest
  app.get("/v1/manifest", (c) => {
    return c.json({
      name: "machinegrade-validate",
      description:
        "Validate AI-generated artifacts against a contract: JSON Schema conformance, OpenAPI response conformance, or SQL syntax.",
      capability: "validate",
      types: VALIDATOR_TYPES,
      auth: { header: "X-Api-Key", issue_key: "POST /keys" },
      limits: {
        free_calls_per_month: authConfig.monthlyLimit,
        rate_limit_per_minute: authConfig.rateLimitPerMinute,
      },
      pricing,
      error_codes: [
        { code: "INVALID_KEY", status: 401 },
        { code: "LIMIT_EXCEEDED", status: 402 },
        { code: "UNSUPPORTED_TYPE", status: 400 },
        { code: "MALFORMED_INPUT", status: 400 },
        { code: "RATE_LIMITED", status: 429 },
      ],
      endpoints: {
        issue_key: "POST /keys",
        validate: "POST /v1/validate",
        manifest: "GET /v1/manifest",
        stats: "GET /stats",
        paid_request: "POST /v1/paid-request",
        openapi: "GET /openapi.yaml",
        llms_txt: "GET /llms.txt",
      },
    });
  });

  // GET /stats, header X-Admin-Token
  app.get("/stats", async (c) => {
    const token = c.req.header("X-Admin-Token");
    if (!token || token !== adminToken) {
      throw invalidKeyError();
    }
    const funnel = await computeFunnel(storage);
    return c.json(funnel, 200);
  });

  // POST /v1/paid-request, header X-Api-Key
  app.post("/v1/paid-request", async (c) => {
    const keyRecord = await auth.requireKey(c.req.header("X-Api-Key"));
    await recordPaidRequest(storage, keyRecord.key);
    return c.json(
      {
        status: "received",
        message: "Paid access opens soon. We'll email you when it's available.",
      },
      202
    );
  });

  // GET /openapi.yaml, GET /llms.txt — static docs (see NOTE above re: Workers).
  app.get("/openapi.yaml", async (c) => {
    const text = await readFile(path.join(ROOT, "openapi.yaml"), "utf-8");
    return c.text(text, 200, { "Content-Type": "application/yaml; charset=utf-8" });
  });

  app.get("/llms.txt", async (c) => {
    const text = await readFile(path.join(ROOT, "public", "llms.txt"), "utf-8");
    return c.text(text, 200, { "Content-Type": "text/plain; charset=utf-8" });
  });

  return app;
}

const app = createApp();
export default app;

// Only start an HTTP listener when this file is run directly (`npm run
// dev` / `npm start`), not when imported by tests or the Workers bundle.
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === `file://${entry}` || import.meta.url === `file://${path.resolve(entry)}`;
})();

if (isMain) {
  const { serve } = await import("@hono/node-server");
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: app.fetch, port }, (info) => {
    console.log(`machinegrade validate listening on http://localhost:${info.port}`);
  });
}
