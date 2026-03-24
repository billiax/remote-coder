import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { CodingAgent, AgentResponse, AgentOptions, HistoryMessage, SessionTool } from "./types";

const OPENCODE_BIN = "opencode";

export class OpenCodeSession implements CodingAgent {
  private sessionId: string | null = null;
  private workingDir: string;
  private model: string;
  private history: HistoryMessage[] = [];

  constructor(opts: AgentOptions) {
    this.sessionId = opts.sessionId ?? null;
    this.workingDir = path.resolve(opts.workingDir);
    this.model = opts.model ?? "";
  }

  private tools: SessionTool[] = [];

  getSessionId(): string | null { return this.sessionId; }
  getWorkingDir(): string { return this.workingDir; }
  getModel(): string { return this.model || "opencode/default"; }
  getHistory(): HistoryMessage[] { return this.history; }
  setTools(tools: SessionTool[]): void { this.tools = tools; }
  getTools(): SessionTool[] { return this.tools; }

  async send(message: string, _images?: any[], _imageUrls?: string[]): Promise<AgentResponse> {
    this.history.push({ role: "user", content: message, timestamp: Date.now() });

    const start = Date.now();
    const args = ["run", "--format", "json", "--dir", this.workingDir];

    if (this.sessionId) {
      args.push("--session", this.sessionId);
    }
    if (this.model) {
      args.push("--model", this.model);
    }
    args.push(message);

    const raw = await this.exec(args);
    const result = this.parseNdjson(raw);

    if (result.sessionId) {
      this.sessionId = result.sessionId;
    }

    const response: AgentResponse = {
      sessionId: this.sessionId ?? "",
      result: result.text || "(no response)",
      isError: false,
      durationMs: Date.now() - start,
      costUsd: result.cost,
    };

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
    // OpenCode doesn't have a compact command — no-op
    return {
      sessionId: this.sessionId ?? "",
      result: "Compact not supported for OpenCode sessions",
      isError: false,
      durationMs: 0,
      costUsd: 0,
    };
  }

  private parseNdjson(raw: string): { sessionId: string; text: string; cost: number } {
    let sessionId = "";
    const textParts: string[] = [];
    let cost = 0;

    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.sessionID) {
          sessionId = event.sessionID;
        }
        if (event.type === "text" && event.part?.text) {
          textParts.push(event.part.text);
        }
        if (event.type === "step_finish" && event.part?.cost != null) {
          cost += event.part.cost;
        }
      } catch {
        // skip unparseable lines
      }
    }

    return { sessionId, text: textParts.join("\n"), cost };
  }

  private exec(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!existsSync(this.workingDir)) {
        reject(new Error(`Working directory does not exist: ${this.workingDir}`));
        return;
      }

      const proc = spawn(OPENCODE_BIN, args, {
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
          reject(new Error(`opencode exited with code ${code}: ${stderr || stdout}`.slice(0, 1000)));
        } else {
          resolve(stdout);
        }
      });

      proc.on("error", (err) => {
        reject(new Error(`Failed to spawn opencode: ${err.message}`));
      });
    });
  }
}
