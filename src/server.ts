import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import path from "path";
import { existsSync, mkdirSync } from "fs";
import { CodingAgent, EngineType } from "./types";
import { createAgent } from "./agent-factory";
import { usesSdk } from "./claude-session";
import { initDb, upsertSession, recordActivity, deleteSessionDb, listSessionsDb } from "./db";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./swagger";

const app = express();

// CORS — allow all origins (API is protected by API key)
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
  res.header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (_req.method === "OPTIONS") { res.sendStatus(200); return; }
  next();
});

app.use(express.json({ limit: "20mb" }));

// --- Configuration via env vars ---

const API_KEY = process.env.API_KEY ?? "";
const DEFAULT_ENGINE = (process.env.DEFAULT_ENGINE ?? "claude") as EngineType;
const VALID_ENGINES: EngineType[] = ["claude", "opencode"];

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!API_KEY) { next(); return; }
  const provided = req.header("X-API-Key") ?? req.query.apiKey ?? "";
  if (provided === API_KEY) { next(); return; }
  res.status(401).json({ error: "Unauthorized" });
}

// Health endpoint is public (for k8s probes)
app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok", engine: DEFAULT_ENGINE });
});

// Static files are public (UI handles auth via JS)
app.use(express.static(path.join(__dirname, "public")));

// Swagger API docs
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
  customCss: '.swagger-ui .topbar { display: none }',
  customSiteTitle: "Remote Coder API",
}));
app.get("/api-docs.json", (_req: Request, res: Response) => res.json(swaggerSpec));

// SPA fallback: /s/:id routes serve index.html
app.get("/s/:id", (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Serve session images (public — filenames are unguessable)
app.get("/images/:workspace/:filename", (req: Request, res: Response) => {
  const ws = path.basename(req.params.workspace as string);
  const filename = path.basename(req.params.filename as string);
  const imgPath = path.join(BASE_DIR, ws, ".session-images", filename);
  if (!existsSync(imgPath)) { res.status(404).end(); return; }
  res.sendFile(path.resolve(imgPath), { dotfiles: "allow" });
});

// API routes require the key
app.use(requireApiKey);

// Base directory where session working dirs live
const BASE_DIR = path.resolve(process.env.BASE_DIR ?? path.join(process.cwd(), "workspaces"));

// Path to MCP config JSON (for Context7 etc.)
const MCP_CONFIG = process.env.MCP_CONFIG ? path.resolve(process.env.MCP_CONFIG) : undefined;

// If set, only these workspace names are allowed
const ALLOWED_WORKSPACES: string[] = (process.env.ALLOWED_WORKSPACES ?? "")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);

// Ensure base dir exists
if (!existsSync(BASE_DIR)) {
  mkdirSync(BASE_DIR, { recursive: true });
}

function resolveWorkspace(workspace: string): string {
  const sanitized = path.basename(workspace);
  if (sanitized !== workspace || workspace.includes("..")) {
    throw new Error(`Invalid workspace name: ${workspace}`);
  }
  return path.join(BASE_DIR, sanitized);
}

function isWorkspaceAllowed(workspace: string): boolean {
  if (ALLOWED_WORKSPACES.length === 0) return true;
  return ALLOWED_WORKSPACES.includes(workspace);
}

// In-memory session store
const sessions = new Map<string, CodingAgent>();

interface ChatRequest {
  message: string;
  sessionId?: string;
  workspace?: string;
  model?: string;
  engine?: EngineType;
  /** Session-level tool definitions — set once, persisted in system prompt */
  tools?: { name: string; description: string; parameters?: Record<string, { type: string; description?: string; required?: boolean }> }[];
  /** Base64-encoded images to include with the message */
  images?: { data: string; media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp" }[];
}

interface ChatResponse {
  sessionId: string;
  response: string;
  isError: boolean;
  durationMs: number;
  costUsd: number;
  workspace: string;
  model: string;
  engine: string;
}

interface ErrorResponse {
  error: string;
}

app.post("/chat", async (req: Request, res: Response<ChatResponse | ErrorResponse>) => {
  const { message, sessionId, workspace, model, engine, tools, images } = req.body as ChatRequest;

  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message is required and must be a string" });
    return;
  }

  if (engine && !VALID_ENGINES.includes(engine)) {
    res.status(400).json({ error: `Invalid engine: ${engine}. Valid: ${VALID_ENGINES.join(", ")}` });
    return;
  }

  let agent: CodingAgent;

  if (sessionId && sessions.has(sessionId)) {
    agent = sessions.get(sessionId)!;
  } else {
    if (!workspace) {
      res.status(400).json({ error: "workspace is required when starting a new session" });
      return;
    }

    if (!isWorkspaceAllowed(workspace)) {
      res.status(403).json({ error: `Workspace not allowed: ${workspace}` });
      return;
    }

    let workDir: string;
    try {
      workDir = resolveWorkspace(workspace);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
      return;
    }

    if (!existsSync(workDir)) {
      mkdirSync(workDir, { recursive: true });
    }

    agent = createAgent(engine ?? DEFAULT_ENGINE, {
      workingDir: workDir,
      model: model ?? (engine === "opencode" ? "" : "sonnet"),
      mcpConfig: MCP_CONFIG,
      sessionId: sessionId ?? undefined,
    });

    if (sessionId) {
      sessions.set(sessionId, agent);
    }
  }

  // Save images to workspace and collect URLs for the frontend
  const imageUrls: string[] = [];
  if (images && Array.isArray(images) && images.length > 0) {
    const ws = path.basename(agent.getWorkingDir());
    const imgDir = path.join(agent.getWorkingDir(), ".session-images");
    if (!existsSync(imgDir)) { mkdirSync(imgDir, { recursive: true }); }
    for (let i = 0; i < images.length; i++) {
      const ext = images[i].media_type.split("/")[1] || "png";
      const filename = `img-${Date.now()}-${i}.${ext}`;
      const imgPath = path.join(imgDir, filename);
      require("fs").writeFileSync(imgPath, Buffer.from(images[i].data, "base64"));
      imageUrls.push(`/images/${ws}/${filename}`);
    }
  }

  // Tools in /chat are ephemeral — prepend to message for this turn only
  let effectiveMessage = message;
  if (tools && Array.isArray(tools) && tools.length > 0) {
    const toolBlock = tools.map(t => {
      let desc = `- **${t.name}**: ${t.description}`;
      if (t.parameters) {
        desc += '\n' + Object.entries(t.parameters)
          .map(([k, v]: [string, any]) => `  - ${k} (${v.type}${v.required ? ', required' : ''}): ${v.description ?? ''}`)
          .join('\n');
      }
      return desc;
    }).join('\n');
    effectiveMessage = `[Available tools for this message]\n${toolBlock}\n\n${message}`;
  }

  try {
    const result = await agent.send(effectiveMessage, images, imageUrls);

    if (!sessions.has(result.sessionId)) {
      sessions.set(result.sessionId, agent);
    }

    const ws = path.basename(agent.getWorkingDir());
    const eng = engine ?? DEFAULT_ENGINE;

    res.json({
      sessionId: result.sessionId,
      response: result.result,
      isError: result.isError,
      durationMs: result.durationMs,
      costUsd: result.costUsd,
      workspace: ws,
      model: agent.getModel(),
      engine: eng,
      ...(imageUrls.length > 0 ? { imageUrls } : {}),
    });

    // Persist to database (fire-and-forget)
    const msgPreview = message.length > 200 ? message.slice(0, 200) + "…" : message;
    const resPreview = result.result.length > 200 ? result.result.slice(0, 200) + "…" : result.result;
    const agentTools = agent.getTools();
    upsertSession(result.sessionId, ws, agent.getModel(), eng, agentTools.length > 0 ? agentTools : null).catch(() => {});
    recordActivity(result.sessionId, "user", msgPreview, null, null, null).catch(() => {});
    recordActivity(result.sessionId, "assistant", resPreview, result.durationMs, result.costUsd, result.inputTokens ?? null).catch(() => {});

    // Auto-compact when input tokens exceed threshold (default 200K)
    const threshold = parseInt(process.env.AUTO_COMPACT_TOKENS ?? "200000", 10);
    if (result.inputTokens && result.inputTokens > threshold) {
      console.log(`[auto-compact] Session ${result.sessionId}: ${result.inputTokens} input tokens > ${threshold} threshold — compacting...`);
      agent.compact().then(c => {
        console.log(`[auto-compact] Session ${result.sessionId}: compacted in ${c.durationMs}ms, cost $${c.costUsd.toFixed(4)}`);
        recordActivity(result.sessionId, "system", "Auto-compacted", c.durationMs, c.costUsd, null).catch(() => {});
      }).catch(err => {
        console.error(`[auto-compact] Session ${result.sessionId}: failed — ${err.message}`);
      });
    }
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "Unknown error" });
  }
});

// POST /sessions/:id/compact
app.post("/sessions/:id/compact", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const agent = sessions.get(id);

  if (!agent) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  try {
    const result = await agent.compact();
    res.json({
      sessionId: result.sessionId,
      response: result.result || "Context compacted successfully",
      durationMs: result.durationMs,
      costUsd: result.costUsd,
    });
    recordActivity(id, "system", "Manual compact", result.durationMs, result.costUsd, null).catch(() => {});
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "Unknown error" });
  }
});

// PUT /sessions/:id/tools — replace all persistent tools for a session
app.put("/sessions/:id/tools", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const agent = sessions.get(id);

  if (!agent) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const { tools } = req.body as { tools: any[] };
  if (!Array.isArray(tools)) {
    res.status(400).json({ error: "tools must be an array" });
    return;
  }

  agent.setTools(tools);
  console.log(`[tools] Session ${id}: replaced with ${tools.length} tool(s): ${tools.map((t: any) => t.name).join(", ")}`);

  // Persist to DB
  const ws = path.basename(agent.getWorkingDir());
  upsertSession(id, ws, agent.getModel(), "claude", tools.length > 0 ? tools : null).catch(() => {});

  res.json({ sessionId: id, tools: agent.getTools() });
});

// GET /sessions/:id/tools — get current persistent tools
app.get("/sessions/:id/tools", (req: Request, res: Response) => {
  const id = req.params.id as string;
  const agent = sessions.get(id);

  if (!agent) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  res.json({ sessionId: id, tools: agent.getTools() });
});

// GET /sessions/:id/history
app.get("/sessions/:id/history", (req: Request, res: Response) => {
  const id = req.params.id as string;
  const agent = sessions.get(id);

  if (!agent) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  res.json({
    sessionId: id,
    workspace: path.basename(agent.getWorkingDir()),
    model: agent.getModel(),
    messages: agent.getHistory(),
  });
});

app.get("/sessions", (_req: Request, res: Response) => {
  const list = Array.from(sessions.entries()).map(([id, s]) => ({
    sessionId: id,
    workspace: path.basename(s.getWorkingDir()),
    model: s.getModel(),
  }));
  res.json({ sessions: list });
});

app.delete("/sessions/:id", (req: Request, res: Response) => {
  const id = req.params.id as string;
  const deleted = sessions.delete(id);
  deleteSessionDb(id).catch(() => {});
  res.json({ deleted });
});

const PORT = parseInt(process.env.PORT ?? "3333", 10);

async function start() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Remote coder running on port ${PORT}`);
    console.log(`Default engine: ${DEFAULT_ENGINE}`);
    console.log(`Workspaces: ${BASE_DIR}`);
    if (DEFAULT_ENGINE === "claude") {
      console.log(`Claude mode: ${usesSdk() ? "SDK (ANTHROPIC_API_KEY)" : "CLI (CLAUDE_CODE_OAUTH_TOKEN)"}`);
    }
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});

export default app;
