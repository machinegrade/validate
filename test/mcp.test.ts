import { describe, expect, it } from "vitest";
import { createApp } from "../src/index.js";
import { MemoryStorage } from "../src/storage.js";
import { issueKey } from "./helpers.js";

function mcpRequest(app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}) {
  return app.request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const initializeMessage = {
  jsonrpc: "2.0" as const,
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" },
  },
};

function toolsListMessage(id: number | string = 2) {
  return { jsonrpc: "2.0" as const, id, method: "tools/list", params: {} };
}

function toolsCallMessage(id: number | string, args: Record<string, unknown>) {
  return {
    jsonrpc: "2.0" as const,
    id,
    method: "tools/call",
    params: { name: "validate", arguments: args },
  };
}

const jsonSchemaArgs = {
  type: "json_schema",
  artifact: { name: "Ada", age: 30 },
  contract: {
    schema: {
      type: "object",
      required: ["name", "age"],
      properties: { name: { type: "string" }, age: { type: "number" } },
    },
  },
};

describe("POST /mcp — discovery (no auth required)", () => {
  it("initialize responds with server info", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const res = await mcpRequest(app, initializeMessage);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result.serverInfo.name).toBe("machinegrade-validate-mcp");
  });

  it("tools/list contains the validate tool, without any X-Api-Key", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const res = await mcpRequest(app, toolsListMessage());

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const names = body.result.tools.map((t: any) => t.name);
    expect(names).toEqual(["validate"]);
  });
});

describe("POST /mcp — tools/call auth", () => {
  it("tools/call without X-Api-Key returns an isError result with the typed INVALID_KEY error", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const res = await mcpRequest(app, toolsCallMessage(3, jsonSchemaArgs));

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.result.isError).toBe(true);
    const errorBody = JSON.parse(body.result.content[0].text);
    expect(errorBody.code).toBe("INVALID_KEY");
  });

  it("tools/call with an unknown X-Api-Key returns INVALID_KEY", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const res = await mcpRequest(app, toolsCallMessage(4, jsonSchemaArgs), { "X-Api-Key": "sk_bogus" });

    const body = (await res.json()) as any;
    expect(body.result.isError).toBe(true);
    const errorBody = JSON.parse(body.result.content[0].text);
    expect(errorBody.code).toBe("INVALID_KEY");
  });
});

describe("POST /mcp — tools/call validate", () => {
  it("happy path: valid artifact returns valid:true", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const key = await issueKey(app);

    const res = await mcpRequest(app, toolsCallMessage(5, jsonSchemaArgs), { "X-Api-Key": key });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.result.isError).toBeFalsy();
    const verdict = JSON.parse(body.result.content[0].text);
    expect(verdict.valid).toBe(true);
    expect(verdict.errors).toEqual([]);
  });

  it("fail path: invalid artifact returns valid:false with errors, not an MCP error", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const key = await issueKey(app);

    const res = await mcpRequest(
      app,
      toolsCallMessage(6, {
        type: "json_schema",
        artifact: { age: "thirty" },
        contract: jsonSchemaArgs.contract,
      }),
      { "X-Api-Key": key }
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.result.isError).toBeFalsy();
    const verdict = JSON.parse(body.result.content[0].text);
    expect(verdict.valid).toBe(false);
    expect(verdict.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("LIMIT_EXCEEDED once the (injectable) monthly limit is reached — same metering path as REST", async () => {
    const app = createApp({
      storage: new MemoryStorage(),
      authConfig: { monthlyLimit: 1, rateLimitPerMinute: 1000 },
    });
    const key = await issueKey(app);

    const res1 = await mcpRequest(app, toolsCallMessage(7, jsonSchemaArgs), { "X-Api-Key": key });
    const body1 = (await res1.json()) as any;
    expect(body1.result.isError).toBeFalsy();

    const res2 = await mcpRequest(app, toolsCallMessage(8, jsonSchemaArgs), { "X-Api-Key": key });
    const body2 = (await res2.json()) as any;
    expect(body2.result.isError).toBe(true);
    const errorBody = JSON.parse(body2.result.content[0].text);
    expect(errorBody.code).toBe("LIMIT_EXCEEDED");
  });
});
