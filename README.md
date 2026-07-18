# machinegrade validate

Validate AI-generated artifacts against a contract before you act on them:

- **`json_schema`** — validate `artifact` against a JSON Schema (ajv, all errors collected).
- **`openapi_response`** — validate a response body against the response schema for a given `path` + `method` + `status` in an OpenAPI spec.
- **`sql`** — check a SQL string for syntax errors in a given dialect.

Every check returns a **verdict**, not an error: `{valid, errors, latency_ms}`,
HTTP 200 whether the artifact is valid or not. Only genuinely wrong requests
(bad key, unsupported type, malformed body, over your limit) get typed HTTP
errors.

Built on Hono — one codebase, runs locally on Node today and is written to
be Cloudflare Workers-compatible for deploy later (see "Deploy" below).

## Why

Agents that generate JSON, API responses, or SQL need a fast, cheap,
machine-checkable pass/fail before they ship the result — cheaper than a
full LLM-as-judge call, and deterministic.

## Run it locally

```bash
npm install
npm run dev
# machinegrade validate listening on http://localhost:8787
```

## 3 runnable examples

### 1. curl

```bash
# Get an API key
curl -s -X POST http://localhost:8787/keys \
  -H 'content-type: application/json' \
  -d '{"email": "you@example.com"}'
# => {"key":"sk_..."}

# Validate a JSON artifact against a JSON Schema
curl -s -X POST http://localhost:8787/v1/validate \
  -H 'content-type: application/json' \
  -H 'X-Api-Key: sk_...' \
  -d '{
    "type": "json_schema",
    "artifact": {"name": "Ada", "age": 30},
    "contract": {
      "schema": {
        "type": "object",
        "required": ["name", "age"],
        "properties": {"name": {"type": "string"}, "age": {"type": "number"}}
      }
    }
  }'
# => {"valid":true,"errors":[],"latency_ms":1}
```

### 2. Python (requests)

```python
import requests

base = "http://localhost:8787"

key = requests.post(f"{base}/keys", json={"email": "you@example.com"}).json()["key"]

resp = requests.post(
    f"{base}/v1/validate",
    headers={"X-Api-Key": key},
    json={
        "type": "sql",
        "artifact": "SELECT id, name FROM users WHERE id = 1",
        "contract": {"dialect": "mysql"},
    },
)
print(resp.status_code, resp.headers.get("X-Calls-Remaining"), resp.json())
```

### 3. MCP config snippet

`mcp/server.ts` exposes a single tool, `validate`, that forwards to
`POST /v1/validate`. Point an MCP-compatible client at it:

```json
{
  "mcpServers": {
    "machinegrade-validate": {
      "command": "npx",
      "args": ["tsx", "mcp/server.ts"],
      "cwd": "/path/to/validate",
      "env": {
        "SANDBOX_URL": "http://localhost:8787",
        "SANDBOX_API_KEY": "sk_..."
      }
    }
  }
}
```

## API

See [`openapi.yaml`](./openapi.yaml) for the full contract, or
[`/v1/manifest`](http://localhost:8787/v1/manifest) for a machine-readable
summary (types, limits, pricing, error codes) once the service is running.
[`/llms.txt`](./public/llms.txt) is a short pointer for LLM agents.

| Endpoint | In | Out |
|---|---|---|
| `POST /keys` | `{email}` | `{key}` |
| `POST /v1/validate` | header `X-Api-Key`, body `{type, artifact, contract?}` | verdict, header `X-Calls-Remaining` |
| `GET /v1/manifest` | — | capability manifest |
| `GET /stats` | header `X-Admin-Token` | funnel: keys_issued, active_callers, repeat_callers_7d, limit_hits, paid_requests |
| `POST /v1/paid-request` | header `X-Api-Key` | records interest in paid access |
| `GET /openapi.yaml`, `GET /llms.txt` | — | static docs |

## Pricing

- **Free tier:** 500 calls/month per key, 60 calls/minute rate limit.
- **Paid tier:** EUR 0.002/call beyond the free tier — **opens soon**.
  Request paid access via `POST /v1/paid-request` (requires `X-Api-Key`);
  you'll be notified when it's live.

## Errors

Every error is typed JSON — `{code, message, hint, docs_url}` — never a
free-form string:

| Code | HTTP status | When |
|---|---|---|
| `INVALID_KEY` | 401 | `X-Api-Key` missing or unknown |
| `LIMIT_EXCEEDED` | 402 | Free-tier monthly limit (500 calls) exceeded |
| `UNSUPPORTED_TYPE` | 400 | `type` is not `json_schema`, `openapi_response`, or `sql` |
| `MALFORMED_INPUT` | 400 | Request body doesn't match the documented shape |
| `RATE_LIMITED` | 429 | More than 60 calls/minute for a key |

A **verdict** (`{valid, errors, latency_ms}`) is never an error — an
invalid artifact is a normal, expected outcome and returns HTTP 200.

## Storage

`src/storage.ts` defines a `Storage` interface with two implementations:

- `MemoryStorage` — full in-memory implementation, used for `npm run dev`
  and the test suite.
- `D1Storage` — stub for a Cloudflare D1 binding. The methods exist so the
  rest of the app depends on one interface, but each currently throws
  `"D1 storage not wired until deploy"`. Wiring real D1 queries is phase P2
  work (needs the owner's Cloudflare account).

## Testing

```bash
npm test          # vitest run, in-process via app.request(), MemoryStorage
npm run typecheck # tsc --noEmit
```

Tests cover: key issuance, happy + fail cases for each validator, typed
401/400/402/429 errors, the metering limits (both injectable in tests so
they don't require looping hundreds of real requests), and `/stats` funnel
counts.

## Deploy (phase P2 — not done here)

This template is written to be Cloudflare Workers-compatible (Hono runs
unmodified there), but is not deployed as part of this phase — that needs
the owner's Cloudflare account, a D1 database, and GitHub secrets. See
`wrangler.toml` and the commented `deploy` job in
`.github/workflows/ci.yml` for what's needed. One known gap to close before
deploying: `GET /openapi.yaml` and `GET /llms.txt` currently read from disk
via `node:fs`, which works locally but not on Workers — switch those two
routes to Workers Static Assets (see the comment in `src/index.ts`).

## Kill criteria

This is a demand-test sandbox for one experiment (see `../experiments/EXP-001-output-validation.md`).
It's built to be disposable: if the experiment doesn't show demand, delete
this directory without ceremony.
