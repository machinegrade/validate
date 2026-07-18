/**
 * Shared MCP tool metadata for "validate". Used by both the stdio adapter
 * (mcp/server.ts, forwards to a possibly-remote HTTP API) and the in-process
 * remote MCP endpoint (src/mcpServer.ts, POST /mcp) — one definition so the
 * two transports can't drift out of sync.
 */
export const VALIDATE_TOOL = {
  name: "validate",
  description:
    "Validate an artifact against a contract (json_schema | openapi_response | sql) via the machinegrade validate API.",
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
