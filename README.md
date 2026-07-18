# machinegrade validate

Validate AI-generated artifacts against a contract before you act on them:

- **`json_schema`** — validate `artifact` against a JSON Schema (all errors collected).
- **`openapi_response`** — validate a response body against the response schema for a given `path` + `method` + `status` in an OpenAPI spec.
- **`sql`** — check a SQL string for syntax errors in a given dialect.

Every check returns a **verdict**, not an error: `{valid, errors, latency_ms}`,
HTTP 200 whether the artifact is valid or not. Only genuinely wrong requests
(bad key, unsupported type, malformed body, over your limit) get typed HTTP
errors.

Live at **https://api.machinegrade.dev** — free tier, self-service key,
try it in 30 seconds (first example below). Built on Hono; the same
codebase runs on Cloudflare Workers (production) and plain Node (local
dev), and is MIT-licensed if you'd rather self-host.

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
# Get an API key (live service — works as-is)
curl -s -X POST https://api.machinegrade.dev/keys \
  -H 'content-type: application/json' \
  -d '{"email": "you@example.com"}'
# => {"key":"sk_..."}

# Validate a JSON artifact against a JSON Schema
curl -s -X POST https://api.machinegrade.dev/v1/validate \
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

## Connect remotely

The production service also exposes an MCP endpoint directly — no local
process, no npm install — via streamable HTTP at:

```
POST https://api.machinegrade.dev/mcp
```

It's the same single `validate` tool as the stdio adapter above.
`initialize` and `tools/list` work without a key (discovery is
anonymous); `tools/call` requires `X-Api-Key` (issue one via `POST
/keys`, same as the REST API — the free tier and limits are shared).

With Claude Code:

```bash
claude mcp add --transport http validate https://api.machinegrade.dev/mcp --header "X-Api-Key: sk_..."
```

The stdio adapter via npm (`@machinegrade/validate`, see above) remains
available for local/offline use or clients without HTTP transport
support.

## API

See [`public/openapi.yaml`](./public/openapi.yaml) for the full contract, or
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
| `POST /mcp` | MCP streamable HTTP, header `X-Api-Key` for `tools/call` | see "Connect remotely" above |

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
- `D1Storage` — real Cloudflare D1 binding, backed by `schema.sql` (`keys`,
  `events` tables). Used in production; the Workers entry point in
  `src/index.ts` builds it from the `DB` binding on first request.

Apply `schema.sql` to a new D1 database with:

```bash
wrangler d1 execute machinegrade-validate-db --file=schema.sql          # local
wrangler d1 execute machinegrade-validate-db --file=schema.sql --remote # production
```

## Testing

```bash
npm test          # vitest run, in-process via app.request(), MemoryStorage
npm run typecheck # tsc --noEmit
```

Tests cover: key issuance, happy + fail cases for each validator, typed
401/400/402/429 errors, the metering limits (both injectable in tests so
they don't require looping hundreds of real requests), and `/stats` funnel
counts.

## Deploy

The service runs on Cloudflare Workers (Hono + D1 + Workers Static
Assets). To self-host on a fresh Cloudflare account:

```bash
wrangler d1 create machinegrade-validate-db   # copy the returned database_id into wrangler.toml
wrangler d1 execute machinegrade-validate-db --file=schema.sql --remote
wrangler secret put ADMIN_TOKEN
wrangler deploy
```

Then bind a custom domain (e.g. `api.machinegrade.dev`) to the Worker via
the Cloudflare dashboard or `wrangler`. CI can deploy on push to `main` once
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` repo secrets are set and
the `deploy` job in `.github/workflows/ci.yml` is uncommented.

Two things worth knowing about the Workers port:

- `GET /openapi.yaml` and `GET /llms.txt` are served by the `ASSETS` binding
  (`[assets]` in `wrangler.toml`, pointing at `public/`) — Cloudflare serves
  them directly, without invoking the Worker. The routes in `src/index.ts`
  are a fallback for local Node dev/tests, where there's no ASSETS binding.
- The `json_schema` and `openapi_response` validators use
  `@cfworker/json-schema`, not `ajv`: ajv compiles schemas via
  `new Function(...)`, which the Workers runtime disallows, and schemas
  here arrive dynamically per request (from the caller), so they can't be
  precompiled at build time either.

## Status

Early stage, honestly so: this service is live and free-tier usage is real,
and we're measuring whether it earns a paid tier. What you can rely on:

- The API contract (`/v1/validate` request/response shapes, typed error
  codes, verdict semantics) is stable — breaking changes only with a
  versioned path (`/v2/...`), never silently.
- The free tier (500 calls/month) stays.
- If we ever sunset the service, keys keep working for 90 days after the
  announcement, and the validators are open source in this repo — you can
  self-host the same behavior.

Feedback and integration stories are the most valuable thing you can give
us right now: open an issue or use `POST /v1/paid-request` if you need
more than the free tier.
