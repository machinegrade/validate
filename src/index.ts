import { Hono } from "hono";
import path from "node:path";
import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";
import { AuthService, DEFAULT_AUTH_CONFIG, type AuthConfig } from "./auth.js";
import { ApiError, invalidKeyError, malformedInputError, unsupportedTypeError } from "./errors.js";
import { D1Storage, MemoryStorage, type Storage } from "./storage.js";
import { computeFunnel, recordCall, recordKeyIssued, recordPaidRequest } from "./telemetry.js";
import { validateJsonSchema } from "./validators/jsonSchema.js";
import { validateOpenapiResponse } from "./validators/openapiResponse.js";
import { validateSql } from "./validators/sql.js";
import type { Verdict, ValidatorInput } from "./validators/common.js";

// GET /openapi.yaml and GET /llms.txt are served two ways:
//  - On Workers (`wrangler deploy`), the `ASSETS` binding (see wrangler.toml
//    `[assets]`, directory `public/`) serves both files directly — Cloudflare
//    intercepts matching requests before the Worker even runs, so the routes
//    below are only reached as a fallback.
//  - Locally (`npm run dev` / tests), there is no ASSETS binding, so the
//    routes read straight from `public/` via `node:fs`. The path is resolved
//    lazily (not at module scope) since `import.meta.url`-based path
//    resolution isn't reliable under the Workers runtime.
function publicDir(): string {
  const here = new URL(".", import.meta.url).pathname;
  return path.resolve(here, "..", "public");
}

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

  // GET /openapi.yaml, GET /llms.txt — static docs. Normally intercepted by
  // the Workers ASSETS binding before reaching the Worker (see comment near
  // `publicDir` above); these handlers are the fallback (Node dev/tests, or
  // an ASSETS binding that didn't match for some reason).
  app.get("/openapi.yaml", async (c) => {
    const assets = (c.env as Env | undefined)?.ASSETS;
    if (assets) return assets.fetch(c.req.raw);
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(path.join(publicDir(), "openapi.yaml"), "utf-8");
    return c.text(text, 200, { "Content-Type": "application/yaml; charset=utf-8" });
  });

  app.get("/llms.txt", async (c) => {
    const assets = (c.env as Env | undefined)?.ASSETS;
    if (assets) return assets.fetch(c.req.raw);
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(path.join(publicDir(), "llms.txt"), "utf-8");
    return c.text(text, 200, { "Content-Type": "text/plain; charset=utf-8" });
  });

  return app;
}

// Only start an HTTP listener when this file is run directly (`npm run
// dev` / `npm start`), not when imported by tests or the Workers bundle.
const isMain = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === `file://${entry}` || import.meta.url === `file://${path.resolve(entry)}`;
})();

if (isMain) {
  const { serve } = await import("@hono/node-server");
  const nodeApp = createApp();
  const port = Number(process.env.PORT ?? 8787);
  serve({ fetch: nodeApp.fetch, port }, (info) => {
    console.log(`machinegrade validate listening on http://localhost:${info.port}`);
  });
}

/**
 * Workers Static Assets binding, typed against the ambient (lib.dom-less)
 * Request/Response used elsewhere in this file — not `@cloudflare/workers-
 * types`' `Fetcher`, whose Request/Response are structurally distinct and
 * don't line up with `c.req.raw` / Hono's return type.
 */
interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

/** Workers bindings, set in wrangler.toml / `wrangler secret put`. */
export interface Env {
  DB?: D1Database;
  ASSETS?: AssetsBinding;
  ADMIN_TOKEN?: string;
}

// Workers entry point (`wrangler deploy`). Bindings are only available
// inside the request handler, not at module-eval time, so the app is built
// lazily on first request and memoized for the isolate's lifetime — D1
// bindings are constant for a given deployment, so this is safe.
let workersApp: ReturnType<typeof createApp> | undefined;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    workersApp ??= createApp({
      storage: env.DB ? new D1Storage(env.DB) : new MemoryStorage(),
      adminToken: env.ADMIN_TOKEN,
    });
    return workersApp.fetch(request, env as never, ctx);
  },
};
