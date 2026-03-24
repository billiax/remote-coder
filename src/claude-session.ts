import { spawn } from "child_process";
import { existsSync, mkdirSync, appendFileSync } from "fs";
import path from "path";
import { CodingAgent, AgentResponse, AgentOptions, HistoryMessage, SessionTool, ImageInput } from "./types";

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

function buildSystemPrompt(dir: string, tools?: SessionTool[]): string {
  const logDir = path.join(dir, ".session-log");
  const lines = [
    `You are working inside the directory: ${dir}`,
    `All file paths must be absolute and within ${dir}.`,
    `The user does NOT have direct access to this directory or its files.`,
    `Always include relevant file contents, command outputs, and results directly in your response.`,
    `When you read, create, or modify files, show the user the content in your reply.`,
    `Use Context7 MCP tools when you need documentation for libraries.`,
    ``,
    `SESSION LOG: Every message (user and assistant) is automatically logged to ${logDir}/ as timestamped .txt files.`,
    `If the conversation context has been compacted and you need to recall earlier messages, read files in ${logDir}/ to find historical content.`,
    `Log files are named like: 2026-03-24T09-15-30-user.txt and 2026-03-24T09-15-30-assistant.txt`,
  ];

  if (tools && tools.length > 0) {
    lines.push(``);
    lines.push(`SESSION TOOLS (IMPORTANT — read carefully):`);
    lines.push(`The user has provided the following external tools for this session.`);
    lines.push(`To invoke a tool, write ONLY the tool call as a fenced code block and STOP. Do NOT continue writing after the tool call.`);
    lines.push(`The user's system will execute the tool and send back the result in the next message as [TOOL RESULT: <tool_name>].`);
    lines.push(`You must NEVER fabricate, guess, or hallucinate tool results. ALWAYS wait for the actual result from the user.`);
    lines.push(`After receiving a tool result, you may then respond to the user or call another tool.`);
    lines.push(``);
    lines.push(`Available tools:`);
    for (const tool of tools) {
      lines.push(`- **${tool.name}**: ${tool.description}`);
      if (tool.parameters) {
        const params = Object.entries(tool.parameters)
          .map(([k, v]) => `    - ${k} (${v.type}${v.required ? ', required' : ''}): ${v.description ?? ''}`)
          .join('\n');
        lines.push(params);
      }
    }
    lines.push(``);
    lines.push(`To call a tool, output EXACTLY this format and nothing else after it:`);
    lines.push('```tool:<tool_name>');
    lines.push('<optional arguments or content>');
    lines.push('```');
    lines.push(``);
    lines.push(`Rules:`);
    lines.push(`1. After outputting a tool call block, STOP immediately. Do not write any text after it.`);
    lines.push(`2. Wait for [TOOL RESULT: <tool_name>] in the next user message before continuing.`);
    lines.push(`3. You may include brief text BEFORE a tool call to explain what you're doing.`);
    lines.push(`4. Never invent tool output. If you don't have a result, you haven't called the tool yet.`);
    lines.push(`5. These tool definitions are persistent for this session and survive compaction.`);
  }

  return lines.join("\n");
}

/**
 * Post-process assistant response: if it contains a tool call block,
 * truncate everything after the closing ``` so the client gets only
 * the tool invocation (no hallucinated results).
 */
function truncateAfterToolCall(text: string, toolNames: string[]): { text: string; toolCall: string | null } {
  if (toolNames.length === 0) return { text, toolCall: null };

  // Build pattern: ```tool:<name> ... ```
  const namePattern = toolNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp('(```tool:(' + namePattern + ')\\s*\\n[\\s\\S]*?```)', 'm');
  const match = text.match(re);
  if (!match) return { text, toolCall: null };

  // Keep everything up to and including the tool block, drop the rest
  const idx = text.indexOf(match[0]);
  const truncated = text.slice(0, idx + match[0].length).trimEnd();
  return { text: truncated, toolCall: match[2] };
}

/** Log a message to the workspace's .session-log directory */
function logMessage(workingDir: string, role: string, content: string): void {
  try {
    const logDir = path.join(workingDir, ".session-log");
    if (!existsSync(logDir)) {
      mkdirSync(logDir, { recursive: true });
    }
    const now = new Date();
    const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `${ts}-${role}.txt`;
    appendFileSync(path.join(logDir, filename), content, "utf-8");
  } catch {
    // Non-critical — don't fail the request if logging fails
  }
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
  private tools: SessionTool[] = [];

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

  setTools(tools: SessionTool[]): void { this.tools = tools; }
  getTools(): SessionTool[] { return this.tools; }

  async send(message: string, images?: ImageInput[], imageUrls?: string[]): Promise<AgentResponse> {
    this.history.push({ role: "user", content: message, timestamp: Date.now(), imageUrls });
    logMessage(this.workingDir, "user", message);

    const response = usesSdk()
      ? await this.sendSdk(message, images)
      : await this.sendCli(message, images);

    // Truncate hallucinated content after tool calls
    if (this.tools.length > 0) {
      const { text, toolCall } = truncateAfterToolCall(
        response.result,
        this.tools.map(t => t.name),
      );
      if (toolCall) {
        response.result = text;
      }
    }

    this.sessionId = response.sessionId;
    this.history.push({
      role: "assistant",
      content: response.result,
      durationMs: response.durationMs,
      costUsd: response.costUsd,
      timestamp: Date.now(),
    });
    logMessage(this.workingDir, "assistant", response.result);

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

  private async sendSdk(message: string, images?: ImageInput[]): Promise<AgentResponse> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const start = Date.now();

    const opts: any = {
      model: resolveModel(this.model),
      cwd: this.workingDir,
      tools: AVAILABLE_TOOLS,
      allowedTools: ALLOWED_TOOL_PATTERNS,
      permissionMode: "dontAsk" as const,
      systemPrompt: buildSystemPrompt(this.workingDir, this.tools),
    };

    if (this.sessionId) {
      opts.resume = this.sessionId;
    }

    // Build prompt: string for text-only, AsyncIterable<SDKUserMessage> for images
    let prompt: any = message;
    if (images && images.length > 0) {
      const contentBlocks: any[] = [];
      for (const img of images) {
        contentBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: img.media_type,
            data: img.data,
          },
        });
      }
      contentBlocks.push({ type: "text", text: message });

      // Wrap as an async iterable that yields one SDKUserMessage
      prompt = (async function* () {
        yield {
          type: "user" as const,
          message: { role: "user" as const, content: contentBlocks },
          parent_tool_use_id: null,
        };
      })();
    }

    let result = "";
    let sessionId = this.sessionId ?? "";
    let costUsd = 0;
    let isError = false;
    let inputTokens = 0;
    let contextWindow = 0;

    for await (const msg of query({ prompt, options: opts })) {
      if (msg.type === "result") {
        result = msg.subtype === "success" ? msg.result : (msg as any).errors?.join("\n") ?? "Error";
        sessionId = (msg as any).session_id;
        costUsd = msg.total_cost_usd ?? 0;
        isError = msg.subtype !== "success";
        // Extract token usage for auto-compact
        if (msg.usage) {
          inputTokens = (msg.usage as any).input_tokens ?? 0;
        }
        if (msg.modelUsage) {
          const models = Object.values(msg.modelUsage);
          if (models.length > 0) {
            contextWindow = (models[0] as any).contextWindow ?? 0;
          }
        }
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
      inputTokens,
      contextWindow,
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

  private async sendCli(message: string, images?: ImageInput[]): Promise<AgentResponse> {
    // If images are present, save them in the workspace so Claude can Read them
    let effectiveMessage = message;
    const tempFiles: string[] = [];

    if (images && images.length > 0) {
      const imgDir = path.join(this.workingDir, ".session-images");
      if (!existsSync(imgDir)) {
        mkdirSync(imgDir, { recursive: true });
      }
      for (let i = 0; i < images.length; i++) {
        const ext = images[i].media_type.split("/")[1] || "png";
        const imgPath = path.join(imgDir, `img-${Date.now()}-${i}.${ext}`);
        appendFileSync(imgPath, Buffer.from(images[i].data, "base64"));
        tempFiles.push(imgPath);
      }
      // Tell Claude to read the images using absolute paths (within workspace)
      const imgRefs = tempFiles.map((f, i) => `[Image ${i + 1} attached — read it with the Read tool: ${f}]`).join("\n");
      effectiveMessage = `${imgRefs}\n\n${message}`;
    }

    const args = [
      "-p", effectiveMessage,
      "--output-format", "json",
      "--model", this.model,
      "--tools", AVAILABLE_TOOLS.join(","),
      "--allowedTools", ...ALLOWED_TOOL_PATTERNS,
      "--permission-mode", "dontAsk",
      "--append-system-prompt", buildSystemPrompt(this.workingDir, this.tools),
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
