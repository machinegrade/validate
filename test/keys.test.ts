import { describe, expect, it } from "vitest";
import { createApp } from "../src/index.js";
import { MemoryStorage } from "../src/storage.js";

describe("POST /keys", () => {
  it("issues a key for a valid email and records a key_issued event", async () => {
    const storage = new MemoryStorage();
    const app = createApp({ storage });

    const res = await app.request("/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "test@example.com" }),
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(typeof body.key).toBe("string");
    expect(body.key.startsWith("sk_")).toBe(true);

    const events = await storage.listEvents({ type: "key_issued" });
    expect(events).toHaveLength(1);
    expect(events[0].email).toBe("test@example.com");
    expect(events[0].key).toBe(body.key);
  });

  it("returns MALFORMED_INPUT for an invalid email", async () => {
    const app = createApp({ storage: new MemoryStorage() });

    const res = await app.request("/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "not-an-email" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.code).toBe("MALFORMED_INPUT");
    expect(body.hint).toBeTruthy();
    expect(body.docs_url).toBeTruthy();
  });

  it("returns MALFORMED_INPUT for a non-JSON body", async () => {
    const app = createApp({ storage: new MemoryStorage() });

    const res = await app.request("/keys", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.code).toBe("MALFORMED_INPUT");
  });
});
