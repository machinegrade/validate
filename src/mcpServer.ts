/**
 * Remote MCP server: exposes the same single "validate" tool as the stdio
 * adapter (mcp/server.ts), but in-process — no HTTP round trip to itself.
 * Mounted at POST /mcp by src/index.ts via a fresh Server + stateless
 * WebStandardStreamableHTTPServerTransport per request (see there for why).
 *
 * Auth model: initialize and tools/list need no key (anonymous discovery).
 * tools/call requires X-Api-Key, read from the transport's per-request
 * `extra.requestInfo.headers` — the same header POST /v1/validate uses —
 * and goes through the same auth.requireKey + processValidate path (limits,
 * telemetry) as the REST endpoint.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { AuthService } from "./auth.js";
import { ApiError } from "./errors.js";
import type { Storage } from "./storage.js";
import { processValidate, type ValidateRequestBody } from "./validate.js";
import { VALIDATE_TOOL } from "./validateTool.js";

export interface McpServerDeps {
  storage: Storage;
  auth: AuthService;
}

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function buildMcpServer(deps: McpServerDeps): Server {
  const server = new Server({ name: "machinegrade-validate-mcp", version: "0.1.1" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [VALIDATE_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (request.params.name !== "validate") {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool "${request.params.name}". Only "validate" is available.` }],
      };
    }

    const apiKey = headerValue(extra.requestInfo?.headers ?? {}, "x-api-key");

    try {
      const keyRecord = await deps.auth.requireKey(apiKey);
      const args = (request.params.arguments ?? {}) as ValidateRequestBody;
      const { verdict } = await processValidate(deps.storage, deps.auth, keyRecord, args);
      return { content: [{ type: "text", text: JSON.stringify(verdict) }] };
    } catch (err) {
      if (err instanceof ApiError) {
        return { isError: true, content: [{ type: "text", text: JSON.stringify(err.toBody()) }] };
      }
      throw err;
    }
  });

  return server;
}
