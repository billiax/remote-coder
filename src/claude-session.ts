import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";

export type ModelAlias = "opus" | "sonnet" | "haiku";

export interface ClaudeResponse {
  sessionId: string;
  result: string;
  isError: boolean;
  durationMs: number;
  costUsd: number;
}

export interface HistoryMessage {
  role: "user" | "claude" | "system";
  content: string;
  durationMs?: number;
  costUsd?: number;
  timestamp: number;
}

export interface SessionOptions {
  /** Directory claude will operate in (read/edit files, run commands) */
  workingDir: string;
  /** Model alias: opus, sonnet, haiku */
  model?: ModelAlias;
  /** Path to MCP config JSON file (optional) */
  mcpConfig?: string;
  /** Additional CLI flags passed to claude */
  extraArgs?: string[];
}

// Tools Claude can see — only file operations, no Bash, no internet.
const AVAILABLE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit"];

// ./** is relative to cwd — claude is spawned with cwd=workingDir,
// so this scopes all file access to the workspace directory.
// MCP tools (Context7) are also pre-approved so they work with dontAsk.
const ALLOWED_TOOL_PATTERNS = [
  "Read(./**)",
  "Write(./**)",
  "Edit(./**)",
  "Glob(./**)",
  "Grep(./**)",
  "NotebookEdit",
  "mcp__context7__resolve-library-id",
  "mcp__context7__query-docs",
];

export class ClaudeSession {
  private sessionId: string | null = null;
  private workingDir: string;
  private model: ModelAlias;
  private mcpConfig: string | undefined;
  private extraArgs: string[];
  private history: HistoryMessage[] = [];

  constructor(opts: SessionOptions & { sessionId?: string }) {
    this.sessionId = opts.sessionId ?? null;
    this.workingDir = path.resolve(opts.workingDir);
    this.model = opts.model ?? "sonnet";
    this.mcpConfig = opts.mcpConfig;
    this.extraArgs = opts.extraArgs ?? [];
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getWorkingDir(): string {
    return this.workingDir;
  }

  getModel(): ModelAlias {
    return this.model;
  }

  getHistory(): HistoryMessage[] {
    return this.history;
  }

  async send(message: string): Promise<ClaudeResponse> {
    this.history.push({ role: "user", content: message, timestamp: Date.now() });
    const dir = this.workingDir;

    const sandboxPrompt = [
      `You are working inside the directory: ${dir}`,
      `All file paths must be absolute and within ${dir}.`,
      `The user does NOT have direct access to this directory or its files.`,
      `Always include relevant file contents, command outputs, and results directly in your response.`,
      `When you read, create, or modify files, show the user the content in your reply.`,
      `Use Context7 MCP tools when you need documentation for libraries.`,
    ].join("\n");

    const args = [
      "-p",
      message,
      "--output-format",
      "json",
      "--model",
      this.model,
      // Only file-operation tools — no Bash, no WebFetch, no WebSearch
      "--tools",
      AVAILABLE_TOOLS.join(","),
      // Pre-approve within workspace only — no permission prompts for these
      "--allowedTools",
      ...ALLOWED_TOOL_PATTERNS,
      // Deny anything not explicitly allowed
      "--permission-mode",
      "dontAsk",
      "--append-system-prompt",
      sandboxPrompt,
    ];

    if (this.mcpConfig) {
      args.push("--mcp-config", this.mcpConfig);
    }

    args.push(...this.extraArgs);

    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    const raw = await this.execClaude(args);

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Failed to parse claude output: ${raw.slice(0, 500)}`);
    }

    if (!parsed.session_id) {
      throw new Error(`No session_id in response: ${raw.slice(0, 500)}`);
    }

    this.sessionId = parsed.session_id;

    const response: ClaudeResponse = {
      sessionId: parsed.session_id,
      result: parsed.result ?? "",
      isError: parsed.is_error ?? false,
      durationMs: parsed.duration_ms ?? 0,
      costUsd: parsed.total_cost_usd ?? 0,
    };

    this.history.push({
      role: "claude",
      content: response.result,
      durationMs: response.durationMs,
      costUsd: response.costUsd,
      timestamp: Date.now(),
    });

    return response;
  }

  async compact(): Promise<ClaudeResponse> {
    if (!this.sessionId) {
      throw new Error("Cannot compact a session that hasn't started yet");
    }

    const args = [
      "-p",
      "/compact",
      "--output-format",
      "json",
      "--resume",
      this.sessionId,
    ];

    const raw = await this.execClaude(args);

    let parsed: any;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Failed to parse claude output: ${raw.slice(0, 500)}`);
    }

    const response: ClaudeResponse = {
      sessionId: parsed.session_id ?? this.sessionId!,
      result: parsed.result ?? "Context compacted",
      isError: parsed.is_error ?? false,
      durationMs: parsed.duration_ms ?? 0,
      costUsd: parsed.total_cost_usd ?? 0,
    };

    this.history.push({
      role: "system",
      content: "Context compacted",
      durationMs: response.durationMs,
      costUsd: response.costUsd,
      timestamp: Date.now(),
    });

    return response;
  }

  private execClaude(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!existsSync(this.workingDir)) {
        reject(new Error(`Working directory does not exist: ${this.workingDir}`));
        return;
      }

      const proc = spawn("claude", args, {
        cwd: this.workingDir,
        env: { ...process.env },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });

      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("close", (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `claude exited with code ${code}: ${stderr || stdout}`.slice(
                0,
                1000
              )
            )
          );
        } else {
          resolve(stdout);
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn claude: ${err.message}`));
      });
    });
  }
}
