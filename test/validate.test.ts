import { describe, expect, it } from "vitest";
import { createApp } from "../src/index.js";
import { MemoryStorage } from "../src/storage.js";
import { issueKey } from "./helpers.js";

function post(app: ReturnType<typeof createApp>, path: string, headers: Record<string, string>, body: unknown) {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/validate — auth", () => {
  it("401 INVALID_KEY when X-Api-Key is missing", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const res = await post(app, "/v1/validate", {}, { type: "json_schema", artifact: {}, contract: { schema: {} } });
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.code).toBe("INVALID_KEY");
    expect(body.hint).toBeTruthy();
    expect(body.docs_url).toBeTruthy();
  });

  it("401 INVALID_KEY when X-Api-Key is unknown", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const res = await post(app, "/v1/validate", { "X-Api-Key": "sk_bogus" }, { type: "json_schema", artifact: {}, contract: { schema: {} } });
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.code).toBe("INVALID_KEY");
  });
});

describe("POST /v1/validate — type: json_schema", () => {
  it("happy path: valid artifact returns valid:true, no errors, sets X-Calls-Remaining", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const key = await issueKey(app);

    const res = await post(
      app,
      "/v1/validate",
      { "X-Api-Key": key },
      {
        type: "json_schema",
        artifact: { name: "Ada", age: 30 },
        contract: {
          schema: {
            type: "object",
            required: ["name", "age"],
            properties: { name: { type: "string" }, age: { type: "number" } },
          },
        },
      }
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("X-Calls-Remaining")).toBe("499");
    const verdict = (await res.json()) as any;
    expect(verdict.valid).toBe(true);
    expect(verdict.errors).toEqual([]);
    expect(typeof verdict.latency_ms).toBe("number");
  });

  it("fail path: invalid artifact collects all errors with actionable fix_hint", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const key = await issueKey(app);

    const res = await post(
      app,
      "/v1/validate",
      { "X-Api-Key": key },
      {
        type: "json_schema",
        artifact: { age: "thirty" },
        contract: {
          schema: {
            type: "object",
            required: ["name", "age"],
            properties: { name: { type: "string" }, age: { type: "number" } },
          },
        },
      }
    );

    expect(res.status).toBe(200);
    const verdict = (await res.json()) as any;
    expect(verdict.valid).toBe(false);
    expect(verdict.errors.length).toBeGreaterThanOrEqual(2); // missing "name" + wrong type "age"
    for (const err of verdict.errors) {
      expect(err.path).toBeDefined();
      expect(err.code).toBeTruthy();
      expect(err.message).toBeTruthy();
      expect(err.fix_hint).toBeTruthy();
    }
  });

  it("MALFORMED_INPUT when contract.schema is missing", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const key = await issueKey(app);

    const res = await post(app, "/v1/validate", { "X-Api-Key": key }, { type: "json_schema", artifact: {} });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.code).toBe("MALFORMED_INPUT");
  });
});

describe("POST /v1/validate — type: openapi_response", () => {
  const spec = {
    paths: {
      "/widgets": {
        get: {
          responses: {
            "200": {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["id"],
                    properties: { id: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    },
  };

  it("happy path: response body matches the spec's response schema", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const key = await issueKey(app);

    const res = await post(
      app,
      "/v1/validate",
      { "X-Api-Key": key },
      {
        type: "openapi_response",
        artifact: { id: "abc-123" },
        contract: { spec, path: "/widgets", method: "get", status: 200 },
      }
    );

    expect(res.status).toBe(200);
    const verdict = (await res.json()) as any;
    expect(verdict.valid).toBe(true);
    expect(verdict.errors).toEqual([]);
  });

  it("fail path: response body missing required field", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const key = await issueKey(app);

    const res = await post(
      app,
      "/v1/validate",
      { "X-Api-Key": key },
      {
        type: "openapi_response",
        artifact: {},
        contract: { spec, path: "/widgets", method: "get", status: 200 },
      }
    );

    expect(res.status).toBe(200);
    const verdict = (await res.json()) as any;
    expect(verdict.valid).toBe(false);
    expect(verdict.errors.length).toBeGreaterThanOrEqual(1);
    expect(verdict.errors[0].fix_hint).toBeTruthy();
  });

  it("MALFORMED_INPUT when path is not found in the spec", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const key = await issueKey(app);

    const res = await post(
      app,
      "/v1/validate",
      { "X-Api-Key": key },
      {
        type: "openapi_response",
        artifact: {},
        contract: { spec, path: "/does-not-exist", method: "get", status: 200 },
      }
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.code).toBe("MALFORMED_INPUT");
  });

  it("MALFORMED_INPUT when method is not defined for the path", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const key = await issueKey(app);

    const res = await post(
      app,
      "/v1/validate",
      { "X-Api-Key": key },
      {
        type: "openapi_response",
        artifact: {},
        contract: { spec, path: "/widgets", method: "post", status: 200 },
      }
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.code).toBe("MALFORMED_INPUT");
  });

  it("MALFORMED_INPUT when status is not defined for the operation", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const key = await issueKey(app);

    const res = await post(
      app,
      "/v1/validate",
      { "X-Api-Key": key },
      {
        type: "openapi_response",
        artifact: {},
        contract: { spec, path: "/widgets", method: "get", status: 404 },
      }
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.code).toBe("MALFORMED_INPUT");
  });
});

describe("POST /v1/validate — type: sql", () => {
  it("happy path: syntactically valid SQL", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const key = await issueKey(app);

    const res = await post(
      app,
      "/v1/validate",
      { "X-Api-Key": key },
      { type: "sql", artifact: "SELECT id, name FROM users WHERE id = 1", contract: { dialect: "mysql" } }
    );

    expect(res.status).toBe(200);
    const verdict = (await res.json()) as any;
    expect(verdict.valid).toBe(true);
    expect(verdict.errors).toEqual([]);
  });

  it("fail path: syntactically invalid SQL produces an error with fix_hint", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const key = await issueKey(app);

    const res = await post(
      app,
      "/v1/validate",
      { "X-Api-Key": key },
      { type: "sql", artifact: "SELEKT * FROM users WHERE", contract: { dialect: "mysql" } }
    );

    expect(res.status).toBe(200);
    const verdict = (await res.json()) as any;
    expect(verdict.valid).toBe(false);
    expect(verdict.errors.length).toBeGreaterThanOrEqual(1);
    expect(verdict.errors[0].code).toBe("SQL_SYNTAX_ERROR");
    expect(verdict.errors[0].fix_hint).toBeTruthy();
  });

  it("MALFORMED_INPUT for an unsupported dialect", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const key = await issueKey(app);

    const res = await post(app, "/v1/validate", { "X-Api-Key": key }, { type: "sql", artifact: "SELECT 1", contract: { dialect: "cobol" } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.code).toBe("MALFORMED_INPUT");
  });
});

describe("POST /v1/validate — type & body validation", () => {
  it("UNSUPPORTED_TYPE for an unknown validator type", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const key = await issueKey(app);

    const res = await post(app, "/v1/validate", { "X-Api-Key": key }, { type: "xml_schema", artifact: "<a/>" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.code).toBe("UNSUPPORTED_TYPE");
    expect(body.hint).toBeTruthy();
  });

  it("MALFORMED_INPUT when artifact is missing", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const key = await issueKey(app);

    const res = await post(app, "/v1/validate", { "X-Api-Key": key }, { type: "json_schema", contract: { schema: {} } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.code).toBe("MALFORMED_INPUT");
  });

  it("MALFORMED_INPUT when type is missing", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const key = await issueKey(app);

    const res = await post(app, "/v1/validate", { "X-Api-Key": key }, { artifact: {} });
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.code).toBe("MALFORMED_INPUT");
  });
});

describe("POST /v1/validate — metering", () => {
  it("402 LIMIT_EXCEEDED once the (injectable) monthly limit is reached", async () => {
    const app = createApp({
      storage: new MemoryStorage(),
      authConfig: { monthlyLimit: 2, rateLimitPerMinute: 1000 },
    });
    const key = await issueKey(app);
    const payload = { type: "sql", artifact: "SELECT 1", contract: { dialect: "mysql" } };

    const res1 = await post(app, "/v1/validate", { "X-Api-Key": key }, payload);
    expect(res1.status).toBe(200);
    expect(res1.headers.get("X-Calls-Remaining")).toBe("1");

    const res2 = await post(app, "/v1/validate", { "X-Api-Key": key }, payload);
    expect(res2.status).toBe(200);
    expect(res2.headers.get("X-Calls-Remaining")).toBe("0");

    const res3 = await post(app, "/v1/validate", { "X-Api-Key": key }, payload);
    expect(res3.status).toBe(402);
    const body = (await res3.json()) as any;
    expect(body.code).toBe("LIMIT_EXCEEDED");
    expect(body.hint.toLowerCase()).toContain("paid-request");
  });

  it("429 RATE_LIMITED once the (injectable) per-minute limit is reached", async () => {
    const app = createApp({
      storage: new MemoryStorage(),
      authConfig: { monthlyLimit: 1000, rateLimitPerMinute: 2 },
    });
    const key = await issueKey(app);
    const payload = { type: "sql", artifact: "SELECT 1", contract: { dialect: "mysql" } };

    await post(app, "/v1/validate", { "X-Api-Key": key }, payload);
    await post(app, "/v1/validate", { "X-Api-Key": key }, payload);
    const res3 = await post(app, "/v1/validate", { "X-Api-Key": key }, payload);

    expect(res3.status).toBe(429);
    const body = (await res3.json()) as any;
    expect(body.code).toBe("RATE_LIMITED");
  });
});
