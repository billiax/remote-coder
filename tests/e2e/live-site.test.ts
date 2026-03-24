/**
 * E2E tests against the live Remote Coder deployment.
 *
 * These tests hit the real production endpoints to verify the service is up
 * and responding correctly. They only test read-only/public endpoints to
 * avoid side effects.
 *
 * Set LIVE_URL env var to override the default URL.
 * Set LIVE_API_KEY env var to test authenticated endpoints.
 *
 * Run with: npm run test:e2e
 */

const LIVE_URL = process.env.LIVE_URL || "https://remote-coder.billiax-cdn.com";
const API_KEY = process.env.LIVE_API_KEY || "";

describe("Live site E2E tests", () => {
  describe("GET /health", () => {
    it("returns 200 with status ok", async () => {
      const res = await fetch(`${LIVE_URL}/health`);
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.status).toBe("ok");
      expect(body.engine).toBeTruthy();
    });
  });

  describe("Static assets", () => {
    it("serves the main page (index.html)", async () => {
      const res = await fetch(LIVE_URL);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Remote Coder");
      expect(html).toContain("<html");
    });

    it("serves the SPA route /s/:id", async () => {
      const res = await fetch(`${LIVE_URL}/s/test-session`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("<html");
    });
  });

  describe("Swagger API docs", () => {
    it("serves Swagger UI at /api-docs", async () => {
      const res = await fetch(`${LIVE_URL}/api-docs/`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("swagger");
    });

    it("serves OpenAPI spec at /api-docs.json", async () => {
      const res = await fetch(`${LIVE_URL}/api-docs.json`);
      expect(res.status).toBe(200);
      const spec: any = await res.json();
      expect(spec.openapi).toBeTruthy();
      expect(spec.info.title).toBe("Remote Coder API");
      expect(spec.paths["/chat"]).toBeDefined();
      expect(spec.paths["/health"]).toBeDefined();
    });
  });

  describe("CORS headers", () => {
    it("returns CORS headers on health endpoint", async () => {
      const res = await fetch(`${LIVE_URL}/health`);
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
    });
  });

  describe("API validation (no auth)", () => {
    it("POST /chat without API key returns 401 or validates input", async () => {
      const res = await fetch(`${LIVE_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      // Either 401 (if API key required) or 400 (if no key required but bad input)
      expect([400, 401]).toContain(res.status);
    });
  });

  // Only run authenticated tests if API key is provided
  const describeAuth = API_KEY ? describe : describe.skip;

  describeAuth("Authenticated endpoints", () => {
    it("GET /sessions returns session list", async () => {
      const res = await fetch(`${LIVE_URL}/sessions`, {
        headers: { "X-API-Key": API_KEY },
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.sessions).toBeDefined();
      expect(Array.isArray(body.sessions)).toBe(true);
    });

    it("POST /chat rejects empty message", async () => {
      const res = await fetch(`${LIVE_URL}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": API_KEY,
        },
        body: JSON.stringify({ workspace: "test" }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error).toContain("message");
    });

    it("POST /chat rejects invalid engine", async () => {
      const res = await fetch(`${LIVE_URL}/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": API_KEY,
        },
        body: JSON.stringify({ message: "test", workspace: "test", engine: "invalid" }),
      });
      expect(res.status).toBe(400);
      const body: any = await res.json();
      expect(body.error).toContain("Invalid engine");
    });

    it("GET /sessions/:id/history returns 404 for nonexistent session", async () => {
      const res = await fetch(`${LIVE_URL}/sessions/nonexistent-e2e-test/history`, {
        headers: { "X-API-Key": API_KEY },
      });
      expect(res.status).toBe(404);
    });

    it("DELETE /sessions/:id handles nonexistent session", async () => {
      const res = await fetch(`${LIVE_URL}/sessions/nonexistent-e2e-test`, {
        method: "DELETE",
        headers: { "X-API-Key": API_KEY },
      });
      expect(res.status).toBe(200);
      const body: any = await res.json();
      expect(body.deleted).toBe(false);
    });
  });
});
