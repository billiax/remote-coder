import { resolveModel, buildSystemPrompt, truncateAfterToolCall } from "../../src/claude-session";
import { SessionTool } from "../../src/types";

describe("resolveModel", () => {
  it("resolves 'opus' to full model ID", () => {
    expect(resolveModel("opus")).toBe("claude-opus-4-6");
  });

  it("resolves 'sonnet' to full model ID", () => {
    expect(resolveModel("sonnet")).toBe("claude-sonnet-4-6");
  });

  it("resolves 'haiku' to full model ID", () => {
    expect(resolveModel("haiku")).toBe("claude-haiku-4-5-20251001");
  });

  it("passes through unknown model IDs unchanged", () => {
    expect(resolveModel("claude-3-opus-20240229")).toBe("claude-3-opus-20240229");
  });

  it("passes through empty string", () => {
    expect(resolveModel("")).toBe("");
  });
});

describe("buildSystemPrompt", () => {
  it("includes the working directory", () => {
    const prompt = buildSystemPrompt("/workspace/test-project");
    expect(prompt).toContain("/workspace/test-project");
  });

  it("includes session log documentation", () => {
    const prompt = buildSystemPrompt("/workspace/test-project");
    expect(prompt).toContain(".session-log");
    expect(prompt).toContain("SESSION CONTINUITY");
  });

  it("includes absolute path requirement", () => {
    const prompt = buildSystemPrompt("/workspace/test-project");
    expect(prompt).toContain("absolute");
  });

  it("includes tool definitions when tools provided", () => {
    const tools: SessionTool[] = [
      { name: "search_web", description: "Search the web for information" },
    ];
    const prompt = buildSystemPrompt("/workspace/test", tools);
    expect(prompt).toContain("SESSION TOOLS");
    expect(prompt).toContain("search_web");
    expect(prompt).toContain("Search the web for information");
  });

  it("includes tool parameters in prompt", () => {
    const tools: SessionTool[] = [
      {
        name: "get_weather",
        description: "Get weather for a city",
        parameters: {
          city: { type: "string", description: "City name", required: true },
          units: { type: "string", description: "Temperature units" },
        },
      },
    ];
    const prompt = buildSystemPrompt("/workspace/test", tools);
    expect(prompt).toContain("city");
    expect(prompt).toContain("required");
    expect(prompt).toContain("units");
  });

  it("includes tool call format instructions", () => {
    const tools: SessionTool[] = [
      { name: "my_tool", description: "A tool" },
    ];
    const prompt = buildSystemPrompt("/workspace/test", tools);
    expect(prompt).toContain("```tool:");
    expect(prompt).toContain("STOP immediately");
  });

  it("does not include tool section when no tools", () => {
    const prompt = buildSystemPrompt("/workspace/test");
    expect(prompt).not.toContain("SESSION TOOLS");
  });

  it("does not include tool section when empty tools array", () => {
    const prompt = buildSystemPrompt("/workspace/test", []);
    expect(prompt).not.toContain("SESSION TOOLS");
  });
});

describe("truncateAfterToolCall", () => {
  it("returns text unchanged when no tool names provided", () => {
    const text = "Hello world";
    const result = truncateAfterToolCall(text, []);
    expect(result.text).toBe("Hello world");
    expect(result.toolCall).toBeNull();
  });

  it("returns text unchanged when no tool call present", () => {
    const text = "Here is some regular text without any tool calls.";
    const result = truncateAfterToolCall(text, ["search_web"]);
    expect(result.text).toBe(text);
    expect(result.toolCall).toBeNull();
  });

  it("truncates text after a tool call block", () => {
    const text = `Let me search for that.
\`\`\`tool:search_web
query: "typescript testing"
\`\`\`
Here are the results I found...
This should be truncated.`;
    const result = truncateAfterToolCall(text, ["search_web"]);
    expect(result.text).toContain("search_web");
    expect(result.text).not.toContain("Here are the results");
    expect(result.text).not.toContain("truncated");
    expect(result.toolCall).toBe("search_web");
  });

  it("handles multiple tool names", () => {
    const text = `I'll use the weather tool.
\`\`\`tool:get_weather
city: London
\`\`\`
The weather is sunny.`;
    const result = truncateAfterToolCall(text, ["search_web", "get_weather"]);
    expect(result.text).toContain("get_weather");
    expect(result.text).not.toContain("sunny");
    expect(result.toolCall).toBe("get_weather");
  });

  it("preserves text before the tool call", () => {
    const text = `Let me help you with that. I'll search now.
\`\`\`tool:search_web
query: test
\`\`\`
Results here.`;
    const result = truncateAfterToolCall(text, ["search_web"]);
    expect(result.text).toContain("Let me help you with that");
    expect(result.toolCall).toBe("search_web");
  });

  it("handles tool names with special regex characters", () => {
    const text = `Using tool.
\`\`\`tool:my.tool
data
\`\`\`
After.`;
    const result = truncateAfterToolCall(text, ["my.tool"]);
    expect(result.toolCall).toBe("my.tool");
  });
});

describe("buildSystemPrompt with ephemeral + persistent tools merged", () => {
  it("includes all tools when both persistent and ephemeral are passed", () => {
    const tools: SessionTool[] = [
      { name: "persistent_tool", description: "A persistent tool" },
      { name: "ephemeral_tool", description: "An ephemeral tool" },
    ];
    const prompt = buildSystemPrompt("/workspace/test", tools);
    expect(prompt).toContain("persistent_tool");
    expect(prompt).toContain("A persistent tool");
    expect(prompt).toContain("ephemeral_tool");
    expect(prompt).toContain("An ephemeral tool");
    expect(prompt).toContain("SESSION TOOLS");
  });

  it("includes invocation instructions for merged tools", () => {
    const tools: SessionTool[] = [
      { name: "tool_a", description: "First tool" },
      { name: "tool_b", description: "Second tool" },
    ];
    const prompt = buildSystemPrompt("/workspace/test", tools);
    expect(prompt).toContain("```tool:");
    expect(prompt).toContain("STOP immediately");
    expect(prompt).toContain("tool_a");
    expect(prompt).toContain("tool_b");
  });

  it("includes parameters from both tools", () => {
    const tools: SessionTool[] = [
      {
        name: "search",
        description: "Search tool",
        parameters: { query: { type: "string", description: "Search query", required: true } },
      },
      {
        name: "fetch_url",
        description: "Fetch a URL",
        parameters: { url: { type: "string", description: "The URL", required: true } },
      },
    ];
    const prompt = buildSystemPrompt("/workspace/test", tools);
    expect(prompt).toContain("query");
    expect(prompt).toContain("Search query");
    expect(prompt).toContain("url");
    expect(prompt).toContain("The URL");
  });
});

describe("truncateAfterToolCall with merged tool names", () => {
  it("truncates for ephemeral tool names in combined list", () => {
    const text = `Calling ephemeral tool.
\`\`\`tool:ephemeral_search
query: test
\`\`\`
Hallucinated results here.`;
    const allToolNames = ["persistent_tool", "ephemeral_search"];
    const result = truncateAfterToolCall(text, allToolNames);
    expect(result.toolCall).toBe("ephemeral_search");
    expect(result.text).not.toContain("Hallucinated results");
  });

  it("truncates for persistent tool names in combined list", () => {
    const text = `Using persistent tool.
\`\`\`tool:persistent_tool
data: value
\`\`\`
Should be removed.`;
    const allToolNames = ["persistent_tool", "ephemeral_tool"];
    const result = truncateAfterToolCall(text, allToolNames);
    expect(result.toolCall).toBe("persistent_tool");
    expect(result.text).not.toContain("Should be removed");
  });
});
