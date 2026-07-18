import { describe, expect, it } from "vitest";
import { createApp } from "../src/index.js";
import { MemoryStorage } from "../src/storage.js";
import { issueKey } from "./helpers.js";

describe("GET /stats", () => {
  it("401 INVALID_KEY when X-Admin-Token is missing or wrong", async () => {
    const app = createApp({ storage: new MemoryStorage(), adminToken: "secret-token" });

    const res1 = await app.request("/stats");
    expect(res1.status).toBe(401);
    expect(((await res1.json()) as any).code).toBe("INVALID_KEY");

    const res2 = await app.request("/stats", { headers: { "X-Admin-Token": "wrong" } });
    expect(res2.status).toBe(401);
  });

  it("defaults X-Admin-Token to dev-admin locally when ADMIN_TOKEN is not set", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const res = await app.request("/stats", { headers: { "X-Admin-Token": "dev-admin" } });
    expect(res.status).toBe(200);
  });

  it("GET /stats/funnel is public and returns aggregate counts only", async () => {
    const storage = new MemoryStorage();
    const app = createApp({ storage, adminToken: "secret-token" });
    await issueKey(app, "public@example.com");

    const res = await app.request("/stats/funnel");
    expect(res.status).toBe(200);
    const funnel = (await res.json()) as any;
    expect(funnel.keys_issued).toBe(1);
    expect(Object.keys(funnel).sort()).toEqual(
      ["active_callers", "keys_issued", "limit_hits", "paid_requests", "repeat_callers_7d"].sort()
    );
  });

  it("computes the funnel: keys_issued, active_callers, limit_hits, paid_requests, repeat_callers_7d", async () => {
    const storage = new MemoryStorage();
    const app = createApp({
      storage,
      adminToken: "secret-token",
      authConfig: { monthlyLimit: 1, rateLimitPerMinute: 1000 },
    });

    const key1 = await issueKey(app, "caller1@example.com");
    const key2 = await issueKey(app, "caller2@example.com");
    const payload = { type: "sql", artifact: "SELECT 1", contract: { dialect: "mysql" } };

    // key1: one successful call (uses the only free call), then a second call trips the limit.
    const ok = await app.request("/v1/validate", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Api-Key": key1 },
      body: JSON.stringify(payload),
    });
    expect(ok.status).toBe(200);

    const over = await app.request("/v1/validate", {
      method: "POST",
      headers: { "content-type": "application/json", "X-Api-Key": key1 },
      body: JSON.stringify(payload),
    });
    expect(over.status).toBe(402);

    // key2: requests paid access, makes no validate calls.
    const paidRes = await app.request("/v1/paid-request", {
      method: "POST",
      headers: { "X-Api-Key": key2 },
    });
    expect(paidRes.status).toBe(202);

    const statsRes = await app.request("/stats", { headers: { "X-Admin-Token": "secret-token" } });
    expect(statsRes.status).toBe(200);
    const funnel = (await statsRes.json()) as any;

    expect(funnel.keys_issued).toBe(2);
    expect(funnel.active_callers).toBe(1); // only key1 made a "call" event
    expect(funnel.limit_hits).toBe(1);
    expect(funnel.paid_requests).toBe(1);
    expect(funnel.repeat_callers_7d).toBe(0); // key1's activity is all on a single day
  });

  it("counts a key as a repeat caller (7d) when it calls on 2+ distinct days within 7 days", async () => {
    const storage = new MemoryStorage();
    const app = createApp({ storage, adminToken: "secret-token" });
    const key = await issueKey(app, "repeat@example.com");

    const DAY = 24 * 60 * 60 * 1000;
    const now = Date.now();
    await storage.recordEvent({
      id: "manual-1",
      type: "call",
      key,
      validator_type: "sql",
      valid: true,
      latency_ms: 1,
      timestamp: now - 1 * DAY,
    });
    await storage.recordEvent({
      id: "manual-2",
      type: "call",
      key,
      validator_type: "sql",
      valid: true,
      latency_ms: 1,
      timestamp: now - 3 * DAY,
    });

    const statsRes = await app.request("/stats", { headers: { "X-Admin-Token": "secret-token" } });
    const funnel = (await statsRes.json()) as any;
    expect(funnel.repeat_callers_7d).toBe(1);
  });
});
