import { describe, expect, it } from "vitest";
import { createApp } from "../src/index.js";
import { MemoryStorage } from "../src/storage.js";
import { issueKey } from "./helpers.js";

describe("POST /v1/paid-request", () => {
  it("401 INVALID_KEY without a valid X-Api-Key", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const res = await app.request("/v1/paid-request", { method: "POST" });
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).code).toBe("INVALID_KEY");
  });

  it("records a paid_request event for a valid key", async () => {
    const storage = new MemoryStorage();
    const app = createApp({ storage });
    const key = await issueKey(app);

    const res = await app.request("/v1/paid-request", {
      method: "POST",
      headers: { "X-Api-Key": key },
    });

    expect(res.status).toBe(202);
    const events = await storage.listEvents({ type: "paid_request", key });
    expect(events).toHaveLength(1);
  });
});
