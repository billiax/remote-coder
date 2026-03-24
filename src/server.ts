import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import path from "path";
import { existsSync, mkdirSync } from "fs";
import { CodingAgent, EngineType, ParsedRequest } from "./types";
import { createAgent } from "./agent-factory";
import { usesSdk } from "./claude-session";
import { initDb, upsertSession, recordActivity, deleteSessionDb, listSessionsDb, logRequest } from "./db";
import swaggerUi from "swagger-ui-express";
import { swaggerSpec } from "./swagger";

const app = express();

// CORS — allow all origins (API is protected by API key)
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, X-API-Key");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
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
const BASE_DIR = path.resolve(process.env.BASE_DIR ?? path.join(require("os").homedir(), ".workspaces"));

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

export function resolveWorkspace(workspace: string): string {
  const sanitized = path.basename(workspace);
  if (sanitized !== workspace || workspace.includes("..")) {
    throw new Error(`Invalid workspace name: ${workspace}`);
  }
  return path.join(BASE_DIR, sanitized);
}

export function isWorkspaceAllowed(workspace: string): boolean {
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
  /** Parsed requests from Claude's response, or null if it's a plain message */
  requests?: ParsedRequest[] | null;
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

  // Helpers for request logging
  const requestStart = Date.now();
  const hasImages = images && Array.isArray(images) && images.length > 0;
  const imageMeta: { index: number; media_type: string; base64_length: number; estimated_mb: string }[] = [];

  const logReq = (status: "ok" | "error" | "validation_error", extra?: { errorMessage?: string; sessionId?: string; durationMs?: number; costUsd?: number }) => {
    logRequest({
      sessionId: extra?.sessionId ?? sessionId,
      endpoint: "/chat",
      workspace: workspace ?? path.basename(agent?.getWorkingDir?.() ?? ""),
      engine: engine ?? DEFAULT_ENGINE,
      model: model ?? agent?.getModel?.() ?? "",
      hasImages: !!hasImages,
      imageCount: hasImages ? images!.length : undefined,
      imageMeta: imageMeta.length > 0 ? imageMeta : undefined,
      status,
      errorMessage: extra?.errorMessage,
      durationMs: extra?.durationMs ?? (Date.now() - requestStart),
      costUsd: extra?.costUsd,
    }).catch(e => console.error(`[request-log] Failed to log: ${e.message}`));
  };

  // Validate & sanitize images
  const imageUrls: string[] = [];
  if (hasImages) {
    for (let i = 0; i < images!.length; i++) {
      const img = images![i];

      // Validate required fields
      if (!img.data || typeof img.data !== "string") {
        const errMsg = `images[${i}].data is required and must be a base64 string (got ${typeof img.data})`;
        console.error(`[images] Image ${i}: ${errMsg}`);
        logReq("validation_error", { errorMessage: errMsg });
        res.status(400).json({ error: errMsg });
        return;
      }

      // Strip data-URI prefix if present (e.g. "data:image/png;base64,...")
      const uriMatch = img.data.match(/^data:(image\/[a-z+]+);base64,(.+)$/s);
      if (uriMatch) {
        console.log(`[images] Image ${i}: stripped data-URI prefix (detected: ${uriMatch[1]})`);
        if (!img.media_type) img.media_type = uriMatch[1] as any;
        img.data = uriMatch[2];
      }

      // Validate media_type
      const validTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
      if (!img.media_type || !validTypes.includes(img.media_type)) {
        const errMsg = `images[${i}].media_type must be one of: ${validTypes.join(", ")} (got "${img.media_type}")`;
        console.error(`[images] Image ${i}: ${errMsg}`);
        logReq("validation_error", { errorMessage: errMsg });
        res.status(400).json({ error: errMsg });
        return;
      }

      // Validate base64 (quick check: no whitespace/non-base64 chars beyond padding)
      const base64Clean = img.data.replace(/\s/g, "");
      if (base64Clean !== img.data) {
        console.log(`[images] Image ${i}: stripped whitespace from base64 data`);
        img.data = base64Clean;
      }
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(img.data)) {
        const errMsg = `images[${i}].data is not valid base64 (length=${img.data.length}, prefix=${img.data.substring(0, 40)})`;
        console.error(`[images] Image ${i}: ${errMsg}`);
        logReq("validation_error", { errorMessage: errMsg });
        res.status(400).json({ error: `images[${i}].data is not valid base64` });
        return;
      }

      // Check decoded size (~3/4 of base64 length)
      const estimatedBytes = Math.ceil(img.data.length * 3 / 4);
      const estimatedMB = (estimatedBytes / (1024 * 1024)).toFixed(2);
      console.log(`[images] Image ${i}: media_type=${img.media_type}, base64_length=${img.data.length}, ~${estimatedMB}MB`);

      imageMeta.push({ index: i, media_type: img.media_type, base64_length: img.data.length, estimated_mb: estimatedMB });

      if (estimatedBytes > 20 * 1024 * 1024) {
        const errMsg = `images[${i}] is too large (~${estimatedMB}MB, max 20MB)`;
        console.error(`[images] Image ${i}: ${errMsg}`);
        logReq("validation_error", { errorMessage: errMsg });
        res.status(400).json({ error: errMsg });
        return;
      }
    }

    // Save images to workspace
    const ws = path.basename(agent.getWorkingDir());
    const imgDir = path.join(agent.getWorkingDir(), ".session-images");
    if (!existsSync(imgDir)) { mkdirSync(imgDir, { recursive: true }); }
    for (let i = 0; i < images!.length; i++) {
      const ext = images![i].media_type.split("/")[1] || "png";
      const filename = `img-${Date.now()}-${i}.${ext}`;
      const imgPath = path.join(imgDir, filename);
      require("fs").writeFileSync(imgPath, Buffer.from(images![i].data, "base64"));
      imageUrls.push(`/images/${ws}/${filename}`);
    }
  }

  // Ephemeral tools are passed through to the agent's system prompt for this turn
  const ephemeralTools = (tools && Array.isArray(tools) && tools.length > 0) ? tools : undefined;

  try {
    const result = await agent.send(message, images, imageUrls, ephemeralTools);

    if (!sessions.has(result.sessionId)) {
      sessions.set(result.sessionId, agent);
    }

    const ws = path.basename(agent.getWorkingDir());
    const eng = engine ?? DEFAULT_ENGINE;

    res.json({
      sessionId: result.sessionId,
      response: result.result,
      requests: result.requests ?? null,
      isError: result.isError,
      durationMs: result.durationMs,
      costUsd: result.costUsd,
      workspace: ws,
      model: agent.getModel(),
      engine: eng,
      ...(imageUrls.length > 0 ? { imageUrls } : {}),
    });

    // Log to request_logs (includes image metadata for debugging)
    logReq(result.isError ? "error" : "ok", {
      sessionId: result.sessionId,
      durationMs: result.durationMs,
      costUsd: result.costUsd,
      errorMessage: result.isError ? result.result.substring(0, 500) : undefined,
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
    console.error(`[chat] Error${hasImages ? ` (with ${images!.length} image(s))` : ""}: ${err.message ?? err}`);
    logReq("error", { errorMessage: (err.message ?? String(err)).substring(0, 500) });
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

app.get("/sessions", async (_req: Request, res: Response) => {
  // Try to get ordering from DB (sorted by last_active DESC)
  const dbSessions = await listSessionsDb();

  if (dbSessions.length > 0) {
    // Use DB order — only include sessions that are still in memory
    const inMemory = new Set(sessions.keys());
    const ordered = dbSessions.filter(s => inMemory.has(s.sessionId));
    // Add any in-memory sessions not yet in DB (newly created) at the front
    const dbIds = new Set(ordered.map(s => s.sessionId));
    const list: { sessionId: string; workspace: string; model: string }[] = [];
    for (const [id, s] of sessions) {
      if (!dbIds.has(id)) {
        list.push({ sessionId: id, workspace: path.basename(s.getWorkingDir()), model: s.getModel() });
      }
    }
    for (const s of ordered) {
      const agent = sessions.get(s.sessionId)!;
      list.push({ sessionId: s.sessionId, workspace: path.basename(agent.getWorkingDir()), model: agent.getModel() });
    }
    res.json({ sessions: list });
  } else {
    // No DB — return in reverse insertion order (latest first)
    const list = Array.from(sessions.entries()).map(([id, s]) => ({
      sessionId: id,
      workspace: path.basename(s.getWorkingDir()),
      model: s.getModel(),
    })).reverse();
    res.json({ sessions: list });
  }
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
  return new Promise<void>((resolve, reject) => {
    const server = app.listen(PORT, () => {
      console.log(`Remote coder running on port ${PORT}`);
      console.log(`Default engine: ${DEFAULT_ENGINE}`);
      console.log(`Workspaces: ${BASE_DIR}`);
      if (DEFAULT_ENGINE === "claude") {
        console.log(`Claude mode: ${usesSdk() ? "SDK (ANTHROPIC_API_KEY)" : "CLI (CLAUDE_CODE_OAUTH_TOKEN)"}`);
      }
      resolve();
    });
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${PORT} is already in use`));
      } else {
        reject(err);
      }
    });
  });
}

start().catch((err) => {
  console.error("Failed to start:", err);
  process.exit(1);
});

export default app;
