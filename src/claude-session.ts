import { spawn } from "child_process";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "fs";
import path from "path";
import { CodingAgent, AgentResponse, AgentOptions, HistoryMessage, SessionTool, ImageInput, ParsedRequest } from "./types";

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
export function resolveModel(model: string): string {
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

const SYSTEM_PROMPT_TEMPLATE = readFileSync(
  path.join(__dirname, "system-prompt.md"),
  "utf-8"
);

const TOOLS_PROMPT_TEMPLATE = readFileSync(
  path.join(__dirname, "tools-prompt.md"),
  "utf-8"
);

export function buildSystemPrompt(dir: string, tools?: SessionTool[]): string {
  const logDir = path.join(dir, ".session-log");

  let toolsSection = "";
  if (tools && tools.length > 0) {
    // Build request list (tools reframed as information sources)
    const requestList = tools.map(tool => {
      let entry = `- **${tool.name}**: ${tool.description}`;
      if (tool.parameters) {
        const params = Object.entries(tool.parameters)
          .map(([k, v]) => `    - ${k} (${v.type}${v.required ? ', required' : ''}): ${v.description ?? ''}`)
          .join('\n');
        entry += '\n  Parameters:\n' + params;
      }
      return entry;
    }).join('\n');

    // Build dynamic examples from actual tools
    const examples: string[] = [];
    const noParamTool = tools.find(t => !t.parameters || Object.keys(t.parameters).length === 0);
    const paramTool = tools.find(t => t.parameters && Object.keys(t.parameters).length > 0);

    if (noParamTool) {
      examples.push(`To request ${noParamTool.name}:`);
      examples.push(JSON.stringify({ type: 'requests', requests: [{ name: noParamTool.name }] }));
      examples.push('');
    }
    if (paramTool && paramTool.parameters) {
      const exampleParams: Record<string, string> = {};
      for (const [k] of Object.entries(paramTool.parameters)) exampleParams[k] = `<${k}>`;
      examples.push(`To request ${paramTool.name} with parameters:`);
      examples.push(JSON.stringify({ type: 'requests', requests: [{ name: paramTool.name, params: exampleParams }] }));
      examples.push('');
    }

    examples.push('To send a plain message:');
    examples.push(JSON.stringify({ type: 'message', content: 'Your reply here' }));

    toolsSection = TOOLS_PROMPT_TEMPLATE
      .replace(/\{\{REQUEST_LIST\}\}/g, requestList)
      .replace(/\{\{REQUEST_EXAMPLES\}\}/g, examples.join('\n'));
  }

  return SYSTEM_PROMPT_TEMPLATE
    .replace(/\{\{DIR\}\}/g, dir)
    .replace(/\{\{LOG_DIR\}\}/g, logDir)
    .replace(/\{\{TOOLS_SECTION\}\}/g, toolsSection)
    .trimEnd();
}

/** Result of parsing assistant response for ```response``` blocks */
export interface ParsedResponse {
  /** The response text (everything before the ```response``` block, or message content) */
  text: string;
  /** Parsed requests, or null if it's a message / no block found */
  requests: ParsedRequest[] | null;
}

/**
 * Extract a balanced JSON object from text starting at the given position.
 * Tracks brace depth and respects string escaping so nested ``` fences
 * inside JSON strings don't break parsing.
 */
function extractBalancedJson(text: string, start: number): string | null {
  // Find the first '{' from start
  let i = start;
  while (i < text.length && text[i] !== '{') i++;
  if (i >= text.length) return null;

  const jsonBegin = i;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (; i < text.length; i++) {
    const ch = text[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\' && inString) { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(jsonBegin, i + 1); }
  }
  return null; // Unbalanced
}

/**
 * Post-process assistant response: extract JSON (raw or inside ```response``` fences)
 * using balanced-brace matching, then parse into structured response.
 */
export function parseResponseBlock(text: string, toolNames: string[]): ParsedResponse {
  if (toolNames.length === 0) return { text, requests: null };

  // Determine where to start looking for JSON:
  // 1. If there's a ```response fence, start after it (backward compat)
  // 2. Otherwise, find the first { in the raw text (new format: raw JSON)
  let jsonSearchStart = 0;
  let textBefore = '';

  const fenceRe = /```response\s*\n/m;
  const fenceMatch = text.match(fenceRe);
  if (fenceMatch) {
    const blockStart = text.indexOf(fenceMatch[0]);
    textBefore = text.slice(0, blockStart).trimEnd();
    jsonSearchStart = blockStart + fenceMatch[0].length;
  }

  const jsonContent = extractBalancedJson(text, jsonSearchStart);
  if (!jsonContent) return { text, requests: null };

  // If no fence was found, textBefore is everything before the JSON
  if (!fenceMatch) {
    const jsonIdx = text.indexOf(jsonContent);
    textBefore = text.slice(0, jsonIdx).trimEnd();
  }

  try {
    const parsed = JSON.parse(jsonContent);

    if (parsed.type === 'requests' && Array.isArray(parsed.requests)) {
      const requests: ParsedRequest[] = parsed.requests
        .filter((r: any) => r && typeof r.name === 'string')
        .map((r: any) => ({ name: r.name, ...(r.params ? { params: r.params } : {}) }));
      return { text: textBefore, requests: requests.length > 0 ? requests : null };
    }

    // Support single request format for backwards compat
    if (parsed.type === 'request' && typeof parsed.name === 'string') {
      const req: ParsedRequest = { name: parsed.name, ...(parsed.params ? { params: parsed.params } : {}) };
      return { text: textBefore, requests: [req] };
    }

    if (parsed.type === 'message' && typeof parsed.content === 'string') {
      return { text: parsed.content, requests: null };
    }
  } catch {
    // Malformed JSON — return text before the block
  }

  return { text: textBefore, requests: null };
}

// Backward-compat wrapper used by send()
export function truncateAfterToolCall(text: string, toolNames: string[]): { text: string; toolCall: string | null } {
  const parsed = parseResponseBlock(text, toolNames);
  return {
    text: parsed.text,
    toolCall: parsed.requests?.[0]?.name ?? null,
  };
}

/**
 * Validate that a response contains a well-formed ```response``` JSON block.
 * Returns an error string if invalid, or null if valid (or no block present).
 */
export function validateResponseBlock(text: string): string | null {
  // Find JSON — either raw or inside ```response fences (backward compat)
  const jsonContent = extractBalancedJson(text, 0);
  if (!jsonContent) {
    // Only flag as error if the text looks like it was trying to be JSON
    if (text.includes('"type"') || text.includes('"message"') || text.includes('"requests"')) {
      return `Response appears to contain JSON but no valid JSON object was found`;
    }
    return null; // Plain text — nothing to validate
  }

  let parsed: any;
  try {
    parsed = JSON.parse(jsonContent);
  } catch (e: any) {
    return `Invalid JSON: ${e.message}. Raw content: ${jsonContent.slice(0, 200)}`;
  }

  if (!parsed.type) {
    return `Missing "type" field. Got: ${JSON.stringify(parsed).slice(0, 200)}`;
  }

  if (parsed.type === 'message') {
    if (typeof parsed.content !== 'string') {
      return `"message" type requires a "content" string field`;
    }
  } else if (parsed.type === 'requests') {
    if (!Array.isArray(parsed.requests)) {
      return `"requests" type requires a "requests" array field`;
    }
    for (let i = 0; i < parsed.requests.length; i++) {
      const r = parsed.requests[i];
      if (!r || typeof r.name !== 'string') {
        return `requests[${i}] must have a "name" string field`;
      }
    }
  } else if (parsed.type === 'request') {
    // Single request format — accepted for backwards compat
    if (typeof parsed.name !== 'string') {
      return `"request" type requires a "name" string field`;
    }
  } else {
    return `Unknown type "${parsed.type}". Must be "message" or "requests"`;
  }

  return null;
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

  async send(message: string, images?: ImageInput[], imageUrls?: string[], ephemeralTools?: SessionTool[]): Promise<AgentResponse> {
    this.history.push({ role: "user", content: message, timestamp: Date.now(), imageUrls });
    logMessage(this.workingDir, "user", message);

    // Merge persistent + ephemeral tools for this turn
    const allTools = [...this.tools, ...(ephemeralTools ?? [])];

    let response = usesSdk()
      ? await this.sendSdk(message, images, allTools)
      : await this.sendCli(message, images, allTools);

    // Parse ```response``` block and extract structured data
    if (allTools.length > 0) {
      // Validate JSON — retry up to 3 times if malformed
      const validationError = validateResponseBlock(response.result);
      if (validationError) {
        response = await this.retryForValidResponse(response, allTools, validationError);
      }

      // Parse the response block into structured fields
      const toolNames = allTools.map(t => t.name);
      const parsed = parseResponseBlock(response.result, toolNames);
      response.result = parsed.text;
      response.requests = parsed.requests;
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

  /**
   * Retry when Claude returns a ```response``` block with invalid JSON.
   * Sends a correction message and retries up to 3 times.
   */
  private async retryForValidResponse(
    lastResponse: AgentResponse,
    allTools: SessionTool[],
    error: string,
    attempt: number = 1,
  ): Promise<AgentResponse> {
    if (attempt > 3) {
      console.warn(`[response-retry] Gave up after 3 attempts. Last error: ${error}`);
      return lastResponse;
    }

    console.log(`[response-retry] Attempt ${attempt}/3: ${error}`);

    // Store the failed assistant response in history so the session has context
    this.sessionId = lastResponse.sessionId;
    this.history.push({
      role: "assistant",
      content: lastResponse.result,
      durationMs: lastResponse.durationMs,
      costUsd: lastResponse.costUsd,
      timestamp: Date.now(),
    });

    const correctionMessage = `Your last response was not valid JSON: ${error}. Please try again — your ENTIRE response must be a single raw JSON object with no markdown fences or other text. It must be either {"type": "message", "content": "..."} or {"type": "requests", "requests": [{"name": "...", "params": {...}}]}.`;

    this.history.push({ role: "user", content: correctionMessage, timestamp: Date.now() });
    logMessage(this.workingDir, "user", correctionMessage);

    let response = usesSdk()
      ? await this.sendSdk(correctionMessage, undefined, allTools)
      : await this.sendCli(correctionMessage, undefined, allTools);

    // Accumulate cost/duration
    response.durationMs += lastResponse.durationMs;
    response.costUsd += lastResponse.costUsd;

    const nextError = validateResponseBlock(response.result);
    if (nextError) {
      return this.retryForValidResponse(response, allTools, nextError, attempt + 1);
    }

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

  private async sendSdk(message: string, images?: ImageInput[], allTools?: SessionTool[]): Promise<AgentResponse> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");
    const start = Date.now();

    const opts: any = {
      model: resolveModel(this.model),
      cwd: this.workingDir,
      tools: AVAILABLE_TOOLS,
      allowedTools: ALLOWED_TOOL_PATTERNS,
      permissionMode: "dontAsk" as const,
      systemPrompt: buildSystemPrompt(this.workingDir, allTools),
    };

    if (this.sessionId) {
      opts.resume = this.sessionId;
    }

    // Build prompt: string for text-only, AsyncIterable<SDKUserMessage> for images
    let prompt: any = message;
    if (images && images.length > 0) {
      const contentBlocks: any[] = [];
      for (const img of images) {
        // Strip data-URI prefix if present (e.g. "data:image/png;base64,...")
        let data = img.data;
        let mediaType = img.media_type;
        const uriMatch = data?.match(/^data:(image\/\w+);base64,(.+)$/s);
        if (uriMatch) {
          if (!mediaType) mediaType = uriMatch[1] as any;
          data = uriMatch[2];
        }
        contentBlocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: mediaType,
            data: data,
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

  private async sendCli(message: string, images?: ImageInput[], allTools?: SessionTool[]): Promise<AgentResponse> {
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

    const hasSessionTools = allTools && allTools.length > 0;
    const args = [
      "-p", effectiveMessage,
      "--output-format", "json",
      "--model", this.model,
      "--tools", hasSessionTools ? "" : AVAILABLE_TOOLS.join(","),
      "--permission-mode", "dontAsk",
      "--append-system-prompt", buildSystemPrompt(this.workingDir, allTools),
    ];

    if (hasSessionTools) {
      // When session tools are defined, block ALL MCP servers and plugins so
      // Claude only sees built-in tools + the text-based session tools.
      // --strict-mcp-config with empty config blocks .mcp.json and env-level MCP servers.
      // --setting-sources "" skips user/project/local settings (disables plugins).
      args.push(
        "--mcp-config", '{"mcpServers":{}}', "--strict-mcp-config",
        "--setting-sources", "",
      );
    } else {
      args.push("--allowedTools", ...ALLOWED_TOOL_PATTERNS);
      if (this.mcpConfig) {
        args.push("--mcp-config", this.mcpConfig);
      }
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
