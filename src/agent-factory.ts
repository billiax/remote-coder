import { CodingAgent, EngineType, AgentOptions } from "./types";
import { ClaudeSession } from "./claude-session";
import { OpenCodeSession } from "./opencode-session";

export function createAgent(engine: EngineType, opts: AgentOptions & { mcpConfig?: string }): CodingAgent {
  switch (engine) {
    case "opencode":
      return new OpenCodeSession(opts);
    case "claude":
    default:
      return new ClaudeSession(opts);
  }
}
