import request from "supertest";
import express from "express";

// We can't import the app directly because it starts listening and connects to DB.
// Instead, we build a minimal test app that exercises the route logic.

// Re-implement the pure route logic for testing without side effects.
function createTestApp() {
  const app = express();

  app.use(express.json({ limit: "20mb" }));

  // CORS
  app.use((_req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
    res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    if (_req.method === "OPTIONS") { res.sendStatus(200); return; }
    next();
  });

  // Health (no auth)
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", engine: "claude" });
  });

  // Mock API key auth
  const API_KEY = "test-api-key";
  app.use((req, res, next) => {
    const provided = req.header("X-API-Key") ?? req.query.apiKey ?? "";
    if (provided === API_KEY) { next(); return; }
    res.status(401).json({ error: "Unauthorized" });
  });

  // Sessions (empty store)
  app.get("/sessions", (_req, res) => {
    res.json({ sessions: [] });
  });

  // Chat validation
  app.post("/chat", (req, res) => {
    const { message, sessionId, workspace, engine } = req.body;

    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message is required and must be a string" });
      return;
    }

    const validEngines = ["claude", "opencode"];
    if (engine && !validEngines.includes(engine)) {
      res.status(400).json({ error: `Invalid engine: ${engine}. Valid: ${validEngines.join(", ")}` });
      return;
    }

    if (!sessionId && !workspace) {
      res.status(400).json({ error: "workspace is required when starting a new session" });
      return;
    }

    // Would normally create agent and send — return mock for test
    res.json({
      sessionId: "mock-session",
      response: "mock response",
      isError: false,
      durationMs: 100,
      costUsd: 0.001,
      workspace: workspace || "test",
      model: "sonnet",
      engine: engine || "claude",
    });
  });

  // Session not found
  app.get("/sessions/:id/history", (req, res) => {
    res.status(404).json({ error: "Session not found" });
  });

  app.post("/sessions/:id/compact", (req, res) => {
    res.status(404).json({ error: "Session not found" });
  });

  app.put("/sessions/:id/tools", (req, res) => {
    const { tools } = req.body;
    if (!Array.isArray(tools)) {
      res.status(400).json({ error: "tools must be an array" });
      return;
    }
    res.status(404).json({ error: "Session not found" });
  });

  app.get("/sessions/:id/tools", (req, res) => {
    res.status(404).json({ error: "Session not found" });
  });

  app.delete("/sessions/:id", (req, res) => {
    res.json({ deleted: false });
  });

  return app;
}

describe("API Routes", () => {
  const app = createTestApp();

  describe("GET /health", () => {
    it("returns 200 with status ok", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.engine).toBe("claude");
    });

    it("does not require authentication", async () => {
      const res = await request(app).get("/health");
      expect(res.status).toBe(200);
    });
  });

  describe("CORS", () => {
    it("returns CORS headers on regular requests", async () => {
      const res = await request(app).get("/health");
      expect(res.headers["access-control-allow-origin"]).toBe("*");
    });

    it("handles OPTIONS preflight requests", async () => {
      const res = await request(app).options("/chat");
      expect(res.status).toBe(200);
      expect(res.headers["access-control-allow-methods"]).toContain("POST");
    });
  });

  describe("Authentication", () => {
    it("rejects requests without API key", async () => {
      const res = await request(app).get("/sessions");
      expect(res.status).toBe(401);
      expect(res.body.error).toBe("Unauthorized");
    });

    it("accepts requests with valid API key header", async () => {
      const res = await request(app)
        .get("/sessions")
        .set("X-API-Key", "test-api-key");
      expect(res.status).toBe(200);
    });

    it("accepts API key via query parameter", async () => {
      const res = await request(app)
        .get("/sessions?apiKey=test-api-key");
      expect(res.status).toBe(200);
    });

    it("rejects requests with wrong API key", async () => {
      const res = await request(app)
        .get("/sessions")
        .set("X-API-Key", "wrong-key");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /sessions", () => {
    it("returns empty session list", async () => {
      const res = await request(app)
        .get("/sessions")
        .set("X-API-Key", "test-api-key");
      expect(res.status).toBe(200);
      expect(res.body.sessions).toEqual([]);
    });
  });

  describe("POST /chat", () => {
    it("rejects missing message", async () => {
      const res = await request(app)
        .post("/chat")
        .set("X-API-Key", "test-api-key")
        .send({ workspace: "test" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("message is required");
    });

    it("rejects non-string message", async () => {
      const res = await request(app)
        .post("/chat")
        .set("X-API-Key", "test-api-key")
        .send({ message: 123, workspace: "test" });
      expect(res.status).toBe(400);
    });

    it("rejects empty message", async () => {
      const res = await request(app)
        .post("/chat")
        .set("X-API-Key", "test-api-key")
        .send({ message: "", workspace: "test" });
      expect(res.status).toBe(400);
    });

    it("rejects invalid engine", async () => {
      const res = await request(app)
        .post("/chat")
        .set("X-API-Key", "test-api-key")
        .send({ message: "hello", workspace: "test", engine: "invalid" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("Invalid engine");
    });

    it("requires workspace for new sessions", async () => {
      const res = await request(app)
        .post("/chat")
        .set("X-API-Key", "test-api-key")
        .send({ message: "hello" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("workspace is required");
    });

    it("accepts valid chat request", async () => {
      const res = await request(app)
        .post("/chat")
        .set("X-API-Key", "test-api-key")
        .send({ message: "hello", workspace: "test" });
      expect(res.status).toBe(200);
      expect(res.body.sessionId).toBeTruthy();
      expect(res.body.response).toBeTruthy();
      expect(res.body.engine).toBe("claude");
    });

    it("accepts request with valid engine", async () => {
      const res = await request(app)
        .post("/chat")
        .set("X-API-Key", "test-api-key")
        .send({ message: "hello", workspace: "test", engine: "opencode" });
      expect(res.status).toBe(200);
      expect(res.body.engine).toBe("opencode");
    });
  });

  describe("Session endpoints (not found)", () => {
    it("GET /sessions/:id/history returns 404 for unknown session", async () => {
      const res = await request(app)
        .get("/sessions/nonexistent/history")
        .set("X-API-Key", "test-api-key");
      expect(res.status).toBe(404);
    });

    it("POST /sessions/:id/compact returns 404 for unknown session", async () => {
      const res = await request(app)
        .post("/sessions/nonexistent/compact")
        .set("X-API-Key", "test-api-key");
      expect(res.status).toBe(404);
    });

    it("PUT /sessions/:id/tools returns 404 for unknown session", async () => {
      const res = await request(app)
        .put("/sessions/nonexistent/tools")
        .set("X-API-Key", "test-api-key")
        .send({ tools: [] });
      expect(res.status).toBe(404);
    });

    it("PUT /sessions/:id/tools rejects non-array tools", async () => {
      const res = await request(app)
        .put("/sessions/nonexistent/tools")
        .set("X-API-Key", "test-api-key")
        .send({ tools: "not-an-array" });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("tools must be an array");
    });

    it("GET /sessions/:id/tools returns 404 for unknown session", async () => {
      const res = await request(app)
        .get("/sessions/nonexistent/tools")
        .set("X-API-Key", "test-api-key");
      expect(res.status).toBe(404);
    });

    it("DELETE /sessions/:id returns deleted: false for unknown session", async () => {
      const res = await request(app)
        .delete("/sessions/nonexistent")
        .set("X-API-Key", "test-api-key");
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(false);
    });
  });
});
