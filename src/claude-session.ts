import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { CodingAgent, AgentResponse, AgentOptions, HistoryMessage } from "./types";

export interface ClaudeSessionOptions extends AgentOptions {
  mcpConfig?: string;
  extraArgs?: string[];
}

// Short aliases → full model IDs (for Anthropic API)
const ALIAS_MAP: Record<string, string> = {
  opus: "claude-opus-4-6",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5-20251001",
};

/** Resolve alias to full model ID, or pass through as-is */
function resolveModel(model: string): string {
  return ALIAS_MAP[model] ?? model;
}

// Tools Claude can see — only file operations, no Bash, no internet.
const AVAILABLE_TOOLS = ["Read", "Write", "Edit", "Glob", "Grep", "NotebookEdit"];

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

function buildSystemPrompt(dir: string): string {
  return [
    `You are working inside the directory: ${dir}`,
    `All file paths must be absolute and within ${dir}.`,
    `The user does NOT have direct access to this directory or its files.`,
    `Always include relevant file contents, command outputs, and results directly in your response.`,
    `When you read, create, or modify files, show the user the content in your reply.`,
    `Use Context7 MCP tools when you need documentation for libraries.`,
  ].join("\n");
}

/** Returns true if ANTHROPIC_API_KEY is set — use SDK. Otherwise use CLI (OAuth). */
export function usesSdk(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export class ClaudeSession implements CodingAgent {
  private sessionId: string | null = null;
  private workingDir: string;
  private model: string;
  private mcpConfig: string | undefined;
  private extraArgs: string[];
  private history: HistoryMessage[] = [];

  constructor(opts: ClaudeSessionOptions) {
    this.sessionId = opts.sessionId ?? null;
    this.workingDir = path.resolve(opts.workingDir);
    this.model = opts.model ?? "sonnet";
    this.mcpConfig = opts.mcpConfig;
    this.extraArgs = opts.extraArgs ?? [];
  }

  getSessionId(): string | null { return this.sessionId; }
  getWorkingDir(): string { return this.workingDir; }
  getModel(): string { return this.model; }
  getHistory(): HistoryMessage[] { return this.history; }

  async send(message: string): Promise<AgentResponse> {
    this.history.push({ role: "user", content: message, timestamp: Date.now() });

    const response = usesSdk()
      ? await this.sendSdk(message)
      : await this.sendCli(message);

    this.sessionId = response.sessionId;
    this.history.push({
      role: "assistant",
      content: response.result,
      durationMs: response.durationMs,
      costUsd: response.costUsd,
      timestamp: Date.now(),
    });

    return response;
  }

  async compact(): Promise<AgentResponse> {
    if (!this.sessionId) {
      throw new Error("Cannot compact a session that hasn't started yet");
    }

    const response = usesSdk()
      ? await this.compactSdk()
      : await this.compactCli();

    this.history.push({
      role: "system",
      content: "Context compacted",
      durationMs: response.durationMs,
      costUsd: response.costUsd,
      timestamp: Date.now(),
    });

    return response;
  }

  // ─── SDK path (ANTHROPIC_API_KEY) ───

  private async sendSdk(message: string): Promise<AgentResponse> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const start = Date.now();

    const opts: any = {
      model: resolveModel(this.model),
      cwd: this.workingDir,
      tools: AVAILABLE_TOOLS,
      allowedTools: ALLOWED_TOOL_PATTERNS,
      permissionMode: "dontAsk" as const,
      systemPrompt: buildSystemPrompt(this.workingDir),
    };

    if (this.sessionId) {
      opts.resume = this.sessionId;
    }

    let result = "";
    let sessionId = this.sessionId ?? "";
    let costUsd = 0;
    let isError = false;

    for await (const msg of query({ prompt: message, options: opts })) {
      if (msg.type === "result") {
        result = msg.subtype === "success" ? msg.result : msg.errors?.join("\n") ?? "Error";
        sessionId = msg.session_id;
        costUsd = msg.total_cost_usd ?? 0;
        isError = msg.subtype !== "success";
      }
    }

    if (!sessionId) {
      throw new Error("No session_id in SDK response");
    }

    return {
      sessionId,
      result,
      isError,
      durationMs: Date.now() - start,
      costUsd,
    };
  }

  private async compactSdk(): Promise<AgentResponse> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const start = Date.now();

    let result = "Context compacted";
    let costUsd = 0;
    let sessionId = this.sessionId!;

    for await (const msg of query({
      prompt: "/compact",
      options: {
        model: resolveModel(this.model),
        resume: this.sessionId!,
      },
    })) {
      if (msg.type === "result") {
        result = msg.subtype === "success" ? (msg.result || "Context compacted") : "Compact failed";
        sessionId = msg.session_id ?? sessionId;
        costUsd = msg.total_cost_usd ?? 0;
      }
    }

    return {
      sessionId,
      result,
      isError: false,
      durationMs: Date.now() - start,
      costUsd,
    };
  }

  // ─── CLI path (CLAUDE_CODE_OAUTH_TOKEN) ───

  private async sendCli(message: string): Promise<AgentResponse> {
    const args = [
      "-p", message,
      "--output-format", "json",
      "--model", this.model,
      "--tools", AVAILABLE_TOOLS.join(","),
      "--allowedTools", ...ALLOWED_TOOL_PATTERNS,
      "--permission-mode", "dontAsk",
      "--append-system-prompt", buildSystemPrompt(this.workingDir),
    ];

    if (this.mcpConfig) {
      args.push("--mcp-config", this.mcpConfig);
    }
    args.push(...this.extraArgs);
    if (this.sessionId) {
      args.push("--resume", this.sessionId);
    }

    const parsed = await this.execClaudeJson(args);

    if (!parsed.session_id) {
      throw new Error(`No session_id in CLI response`);
    }

    return {
      sessionId: parsed.session_id,
      result: parsed.result ?? "",
      isError: parsed.is_error ?? false,
      durationMs: parsed.duration_ms ?? 0,
      costUsd: parsed.total_cost_usd ?? 0,
    };
  }

  private async compactCli(): Promise<AgentResponse> {
    const args = [
      "-p", "/compact",
      "--output-format", "json",
      "--resume", this.sessionId!,
    ];

    const parsed = await this.execClaudeJson(args);

    return {
      sessionId: parsed.session_id ?? this.sessionId!,
      result: parsed.result ?? "Context compacted",
      isError: parsed.is_error ?? false,
      durationMs: parsed.duration_ms ?? 0,
      costUsd: parsed.total_cost_usd ?? 0,
    };
  }

  private async execClaudeJson(args: string[]): Promise<any> {
    const raw = await this.execClaude(args);
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`Failed to parse claude output: ${raw.slice(0, 500)}`);
    }
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

      proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      proc.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`claude exited with code ${code}: ${stderr || stdout}`.slice(0, 1000)));
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
