#!/usr/bin/env node
/**
 * Thin MCP stdio adapter over the machinegrade validate HTTP API.
 *
 * Exposes a single tool, "validate", that forwards to POST /v1/validate.
 * Configuration is via environment variables:
 *   SANDBOX_URL     - base URL of a running machinegrade validate instance
 *                      (default: http://localhost:8787)
 *   SANDBOX_API_KEY - API key to send as X-Api-Key (issue one via
 *                      POST /keys first; required to call the tool)
 *
 * Run directly with: npm run mcp
 * (or point an MCP-compatible client at `tsx mcp/server.ts`).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const SANDBOX_URL = process.env.SANDBOX_URL ?? "http://localhost:8787";

const VALIDATE_TOOL = {
  name: "validate",
  description:
    "Validate an artifact against a contract (json_schema | openapi_response | sql) via the machinegrade validate HTTP API's POST /v1/validate.",
  inputSchema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: ["json_schema", "openapi_response", "sql"],
        description: "Which validator to run.",
      },
      artifact: {
        description: "The artifact to validate (object for json_schema/openapi_response, SQL string for sql).",
      },
      contract: {
        description:
          "Validator-specific contract. json_schema: { schema }. openapi_response: { spec, path, method, status }. sql: { dialect }.",
      },
    },
    required: ["type", "artifact"],
  },
} as const;

function buildServer(): Server {
  const server = new Server(
    { name: "machinegrade-validate-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [VALIDATE_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "validate") {
      return {
        isError: true,
        content: [{ type: "text", text: `Unknown tool "${request.params.name}". Only "validate" is available.` }],
      };
    }

    const apiKey = process.env.SANDBOX_API_KEY;
    if (!apiKey) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Missing SANDBOX_API_KEY. Issue a key with POST /keys against SANDBOX_URL and set SANDBOX_API_KEY before calling this tool.",
          },
        ],
      };
    }

    const args = (request.params.arguments ?? {}) as { type?: unknown; artifact?: unknown; contract?: unknown };

    try {
      const res = await fetch(`${SANDBOX_URL}/v1/validate`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-Api-Key": apiKey,
        },
        body: JSON.stringify({ type: args.type, artifact: args.artifact, contract: args.contract }),
      });

      const text = await res.text();
      if (!res.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: `machinegrade validate returned HTTP ${res.status}: ${text}` }],
        };
      }

      return { content: [{ type: "text", text }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text", text: `Failed to reach ${SANDBOX_URL}: ${(err as Error).message}` }],
      };
    }
  });

  return server;
}

async function main() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("machinegrade validate MCP server failed to start:", err);
  process.exit(1);
});
