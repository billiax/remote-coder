import express, { Request, Response } from "express";
import path from "path";
import { existsSync, mkdirSync } from "fs";
import { ClaudeSession, ModelAlias } from "./claude-session";

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// --- Configuration via env vars ---

// Base directory where session working dirs live
const BASE_DIR = path.resolve(process.env.BASE_DIR ?? path.join(process.cwd(), "workspaces"));

// Path to MCP config JSON (for Context7 etc.)
const MCP_CONFIG = process.env.MCP_CONFIG ? path.resolve(process.env.MCP_CONFIG) : undefined;

// If set, only these workspace names are allowed
const ALLOWED_WORKSPACES: string[] = (process.env.ALLOWED_WORKSPACES ?? "")
  .split(",")
  .map((d) => d.trim())
  .filter(Boolean);

const VALID_MODELS: ModelAlias[] = ["opus", "sonnet", "haiku"];

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
const sessions = new Map<string, ClaudeSession>();

interface ChatRequest {
  message: string;
  sessionId?: string;
  workspace?: string;
  model?: ModelAlias;
}

interface ChatResponse {
  sessionId: string;
  response: string;
  isError: boolean;
  durationMs: number;
  costUsd: number;
  workspace: string;
  model: string;
}

interface ErrorResponse {
  error: string;
}

app.post("/chat", async (req: Request, res: Response<ChatResponse | ErrorResponse>) => {
  const { message, sessionId, workspace, model } = req.body as ChatRequest;

  if (!message || typeof message !== "string") {
    res.status(400).json({ error: "message is required and must be a string" });
    return;
  }

  if (model && !VALID_MODELS.includes(model)) {
    res.status(400).json({ error: `Invalid model: ${model}. Valid: ${VALID_MODELS.join(", ")}` });
    return;
  }

  let session: ClaudeSession;

  if (sessionId && sessions.has(sessionId)) {
    session = sessions.get(sessionId)!;
  } else {
    if (!workspace) {
      res.status(400).json({
        error: "workspace is required when starting a new session",
      });
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

    session = new ClaudeSession({
      workingDir: workDir,
      model: model ?? "sonnet",
      mcpConfig: MCP_CONFIG,
      sessionId: sessionId ?? undefined,
    });

    if (sessionId) {
      sessions.set(sessionId, session);
    }
  }

  try {
    const result = await session.send(message);

    if (!sessions.has(result.sessionId)) {
      sessions.set(result.sessionId, session);
    }

    res.json({
      sessionId: result.sessionId,
      response: result.result,
      isError: result.isError,
      durationMs: result.durationMs,
      costUsd: result.costUsd,
      workspace: path.basename(session.getWorkingDir()),
      model: session.getModel(),
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message ?? "Unknown error" });
  }
});

// POST /sessions/:id/compact - compact session context
app.post("/sessions/:id/compact", async (req: Request, res: Response) => {
  const id = req.params.id as string;
  const session = sessions.get(id);

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  try {
    const result = await session.compact();
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

// GET /sessions/:id/history - get message history for a session
app.get("/sessions/:id/history", (req: Request, res: Response) => {
  const id = req.params.id as string;
  const session = sessions.get(id);

  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  res.json({
    sessionId: id,
    workspace: path.basename(session.getWorkingDir()),
    model: session.getModel(),
    messages: session.getHistory(),
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

app.get("/health", (_req: Request, res: Response) => {
  res.json({ status: "ok" });
});

const PORT = parseInt(process.env.PORT ?? "3333", 10);
app.listen(PORT, () => {
  console.log(`Claude session service running on port ${PORT}`);
  console.log(`Workspaces: ${BASE_DIR}`);
  console.log(`MCP config: ${MCP_CONFIG ?? "(none)"}`);
  console.log(`Allowed workspaces: ${ALLOWED_WORKSPACES.length ? ALLOWED_WORKSPACES.join(", ") : "(any)"}`);
});

export default app;
