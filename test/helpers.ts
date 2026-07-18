import type { Hono } from "hono";

export async function issueKey(app: Hono, email = "user@example.com"): Promise<string> {
  const res = await app.request("/keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email }),
  });
  const body = (await res.json()) as { key: string };
  return body.key;
}

export function validateRequest(type: string, artifact: unknown, contract?: unknown) {
  return {
    method: "POST" as const,
    body: JSON.stringify({ type, artifact, contract }),
  };
}
