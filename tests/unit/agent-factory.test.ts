import { createAgent } from "../../src/agent-factory";
import { ClaudeSession } from "../../src/claude-session";
import { OpenCodeSession } from "../../src/opencode-session";

describe("createAgent", () => {
  const baseOpts = { workingDir: "/tmp/test-workspace", model: "sonnet" };

  it("creates a ClaudeSession for engine 'claude'", () => {
    const agent = createAgent("claude", baseOpts);
    expect(agent).toBeInstanceOf(ClaudeSession);
  });

  it("creates an OpenCodeSession for engine 'opencode'", () => {
    const agent = createAgent("opencode", baseOpts);
    expect(agent).toBeInstanceOf(OpenCodeSession);
  });

  it("defaults to ClaudeSession for unknown engine", () => {
    const agent = createAgent("unknown" as any, baseOpts);
    expect(agent).toBeInstanceOf(ClaudeSession);
  });

  it("passes model to the agent", () => {
    const agent = createAgent("claude", { workingDir: "/tmp/test", model: "opus" });
    expect(agent.getModel()).toBe("opus");
  });

  it("passes working directory to the agent", () => {
    const agent = createAgent("claude", { workingDir: "/tmp/my-workspace" });
    expect(agent.getWorkingDir()).toContain("my-workspace");
  });

  it("starts with empty history", () => {
    const agent = createAgent("claude", baseOpts);
    expect(agent.getHistory()).toEqual([]);
  });

  it("starts with no session ID", () => {
    const agent = createAgent("claude", baseOpts);
    expect(agent.getSessionId()).toBeNull();
  });

  it("starts with empty tools", () => {
    const agent = createAgent("claude", baseOpts);
    expect(agent.getTools()).toEqual([]);
  });

  it("accepts sessionId in options", () => {
    const agent = createAgent("claude", { ...baseOpts, sessionId: "test-123" });
    expect(agent.getSessionId()).toBe("test-123");
  });
});
