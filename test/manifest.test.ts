import { describe, expect, it } from "vitest";
import { createApp } from "../src/index.js";
import { MemoryStorage } from "../src/storage.js";

describe("GET /v1/manifest", () => {
  it("returns machine-readable capability, types, limits, pricing, and error codes", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const res = await app.request("/v1/manifest");
    expect(res.status).toBe(200);

    const manifest = (await res.json()) as any;
    expect(manifest.capability).toBe("validate");
    expect(manifest.types).toEqual(["json_schema", "openapi_response", "sql"]);
    expect(manifest.limits.free_calls_per_month).toBe(500);
    expect(manifest.limits.rate_limit_per_minute).toBe(60);
    expect(manifest.pricing.paid_price_eur_per_call).toBe(0.002);
    expect(manifest.pricing.free_calls_per_month).toBe(500);

    const codes = manifest.error_codes.map((e: { code: string }) => e.code);
    expect(codes).toEqual(
      expect.arrayContaining(["INVALID_KEY", "LIMIT_EXCEEDED", "UNSUPPORTED_TYPE", "MALFORMED_INPUT", "RATE_LIMITED"])
    );
  });
});

describe("GET /openapi.yaml and GET /llms.txt", () => {
  it("serves the OpenAPI spec as text", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const res = await app.request("/openapi.yaml");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("openapi:");
    expect(text).toContain("/v1/validate");
  });

  it("serves llms.txt as text", async () => {
    const app = createApp({ storage: new MemoryStorage() });
    const res = await app.request("/llms.txt");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("/openapi.yaml");
  });
});
