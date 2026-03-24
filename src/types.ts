export interface AgentResponse {
  sessionId: string;
  result: string;
  isError: boolean;
  durationMs: number;
  costUsd: number;
  /** Total input tokens used in this turn (for auto-compact decisions) */
  inputTokens?: number;
  /** Context window size for the model */
  contextWindow?: number;
}

export interface HistoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
  durationMs?: number;
  costUsd?: number;
  timestamp: number;
  imageUrls?: string[];
}

/** Base64 image to include in a message */
export interface ImageInput {
  /** Base64-encoded image data (no data: prefix) */
  data: string;
  /** MIME type: image/png, image/jpeg, image/gif, image/webp */
  media_type: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

/** A user-defined tool that the session can invoke */
export interface SessionTool {
  name: string;
  description: string;
  parameters?: Record<string, { type: string; description?: string; required?: boolean }>;
}

export interface AgentOptions {
  workingDir: string;
  model?: string;
  sessionId?: string;
}

export interface CodingAgent {
  send(message: string, images?: ImageInput[], imageUrls?: string[], ephemeralTools?: SessionTool[]): Promise<AgentResponse>;
  compact(): Promise<AgentResponse>;
  getSessionId(): string | null;
  getWorkingDir(): string;
  getModel(): string;
  getHistory(): HistoryMessage[];
  /** Set session-level tool definitions (persisted in system prompt, not history) */
  setTools(tools: SessionTool[]): void;
  getTools(): SessionTool[];
}

export type EngineType = "claude" | "opencode";
