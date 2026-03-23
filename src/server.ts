import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import path from "path";
import { existsSync, mkdirSync } from "fs";
import { CodingAgent, EngineType } from "./types";
import { createAgent } from "./agent-factory";
import { usesSdk } from "./claude-session";

const app = express();
app.use(express.json({ limit: "1mb" }));

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
  const { message, sessionId, workspace, model, engine } = req.body as ChatRequest;

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

  try {
    const result = await agent.send(message);

    if (!sessions.has(result.sessionId)) {
      sessions.set(result.sessionId, agent);
    }

    res.json({
      sessionId: result.sessionId,
      response: result.result,
      isError: result.isError,
      durationMs: result.durationMs,
      costUsd: result.costUsd,
      workspace: path.basename(agent.getWorkingDir()),
      model: agent.getModel(),
      engine: engine ?? DEFAULT_ENGINE,
    });
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
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "Unknown error" });
  }
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
  res.json({ deleted });
});

const PORT = parseInt(process.env.PORT ?? "3333", 10);
app.listen(PORT, () => {
  console.log(`Remote coder running on port ${PORT}`);
  console.log(`Default engine: ${DEFAULT_ENGINE}`);
  console.log(`Workspaces: ${BASE_DIR}`);
  if (DEFAULT_ENGINE === "claude") {
    console.log(`Claude mode: ${usesSdk() ? "SDK (ANTHROPIC_API_KEY)" : "CLI (CLAUDE_CODE_OAUTH_TOKEN)"}`);
  }
});

export default app;
