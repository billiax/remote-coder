export interface AgentResponse {
  sessionId: string;
  result: string;
  isError: boolean;
  durationMs: number;
  costUsd: number;
}

export interface HistoryMessage {
  role: "user" | "assistant" | "system";
  content: string;
  durationMs?: number;
  costUsd?: number;
  timestamp: number;
}

export interface AgentOptions {
  workingDir: string;
  model?: string;
  sessionId?: string;
}

export interface CodingAgent {
  send(message: string): Promise<AgentResponse>;
  compact(): Promise<AgentResponse>;
  getSessionId(): string | null;
  getWorkingDir(): string;
  getModel(): string;
  getHistory(): HistoryMessage[];
}

export type EngineType = "claude" | "opencode";
