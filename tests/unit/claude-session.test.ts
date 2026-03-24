import { resolveModel, buildSystemPrompt, truncateAfterToolCall, validateResponseBlock, parseResponseBlock } from "../../src/claude-session";
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

  it("includes request definitions when tools provided", () => {
    const tools: SessionTool[] = [
      { name: "search_web", description: "Search the web for information" },
    ];
    const prompt = buildSystemPrompt("/workspace/test", tools);
    expect(prompt).toContain("RESPONSE PROTOCOL");
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

  it("includes response format instructions with requests type", () => {
    const tools: SessionTool[] = [
      { name: "my_tool", description: "A tool" },
    ];
    const prompt = buildSystemPrompt("/workspace/test", tools);
    expect(prompt).toContain("RESPONSE PROTOCOL");
    expect(prompt).toContain('"type"');
    expect(prompt).toContain('"requests"');
    expect(prompt).toContain('"message"');
  });

  it("does not include response protocol when no tools", () => {
    const prompt = buildSystemPrompt("/workspace/test");
    expect(prompt).not.toContain("RESPONSE PROTOCOL");
  });

  it("does not include response protocol when empty tools array", () => {
    const prompt = buildSystemPrompt("/workspace/test", []);
    expect(prompt).not.toContain("RESPONSE PROTOCOL");
  });
});

describe("parseResponseBlock", () => {
  it("returns text unchanged when no tool names provided", () => {
    const result = parseResponseBlock("Hello world", []);
    expect(result.text).toBe("Hello world");
    expect(result.requests).toBeNull();
  });

  it("returns text unchanged when no response block present", () => {
    const text = "Just regular text.";
    const result = parseResponseBlock(text, ["search_web"]);
    expect(result.text).toBe(text);
    expect(result.requests).toBeNull();
  });

  it("parses single request (requests type)", () => {
    const text = '```response\n{"type": "requests", "requests": [{"name": "page_snapshot"}]}\n```';
    const result = parseResponseBlock(text, ["page_snapshot"]);
    expect(result.requests).toEqual([{ name: "page_snapshot" }]);
    expect(result.text).toBe("");
  });

  it("parses single request with params", () => {
    const text = '```response\n{"type": "requests", "requests": [{"name": "click", "params": {"selector": "#btn"}}]}\n```';
    const result = parseResponseBlock(text, ["click"]);
    expect(result.requests).toEqual([{ name: "click", params: { selector: "#btn" } }]);
  });

  it("parses multiple requests", () => {
    const text = '```response\n{"type": "requests", "requests": [{"name": "page_snapshot"}, {"name": "console_logs"}]}\n```';
    const result = parseResponseBlock(text, ["page_snapshot", "console_logs"]);
    expect(result.requests).toHaveLength(2);
    expect(result.requests![0].name).toBe("page_snapshot");
    expect(result.requests![1].name).toBe("console_logs");
  });

  it("extracts content field from requests", () => {
    const text = '```response\n{"type": "requests", "content": "Let me check.", "requests": [{"name": "page_snapshot"}]}\n```';
    const result = parseResponseBlock(text, ["page_snapshot"]);
    expect(result.requests).toEqual([{ name: "page_snapshot" }]);
    expect(result.text).toBe("");
  });

  it("parses message type and extracts content", () => {
    const text = '```response\n{"type": "message", "content": "The answer is 42"}\n```';
    const result = parseResponseBlock(text, ["search_web"]);
    expect(result.text).toBe("The answer is 42");
    expect(result.requests).toBeNull();
  });

  it("returns text before block for requests", () => {
    const text = 'Some explanation.\n```response\n{"type": "requests", "requests": [{"name": "search"}]}\n```';
    const result = parseResponseBlock(text, ["search"]);
    expect(result.text).toBe("Some explanation.");
    expect(result.requests).toEqual([{ name: "search" }]);
  });

  it("strips text after block", () => {
    const text = '```response\n{"type": "requests", "requests": [{"name": "search"}]}\n```\nHallucinated result.';
    const result = parseResponseBlock(text, ["search"]);
    expect(result.text).not.toContain("Hallucinated");
  });

  it("handles backward-compat single request type", () => {
    const text = '```response\n{"type": "request", "name": "page_snapshot"}\n```';
    const result = parseResponseBlock(text, ["page_snapshot"]);
    expect(result.requests).toEqual([{ name: "page_snapshot" }]);
  });

  it("handles malformed JSON gracefully", () => {
    const text = '```response\n{not valid}\n```\nAfter.';
    const result = parseResponseBlock(text, ["my_tool"]);
    expect(result.requests).toBeNull();
    expect(result.text).not.toContain("After.");
  });

  it("handles nested code fences inside JSON content", () => {
    // Agent embeds a code block inside the message content — the inner ```
    // should not break parsing
    const json = '{"type": "message", "content": "Here is the code:\\n\\n```javascript\\nconst x = 1;\\n```\\n\\nDone."}';
    const text = '```response\n' + json + '\n```';
    const result = parseResponseBlock(text, ["screenshot"]);
    expect(result.requests).toBeNull();
    expect(result.text).toContain("Here is the code:");
    expect(result.text).toContain("Done.");
  });

  it("handles nested code fences with triple backticks in JSON strings", () => {
    const json = '{"type": "requests", "requests": [{"name": "screenshot"}]}';
    // Extra ``` after the block should be ignored
    const text = 'Some explanation\n```response\n' + json + '\n```\nHallucinated results here';
    const result = parseResponseBlock(text, ["screenshot"]);
    expect(result.requests).toEqual([{ name: "screenshot" }]);
    expect(result.text).toBe("Some explanation");
  });

  // --- Raw JSON format (no fences) ---

  it("parses raw JSON message response", () => {
    const text = '{"type": "message", "content": "Hello world"}';
    const result = parseResponseBlock(text, ["screenshot"]);
    expect(result.requests).toBeNull();
    expect(result.text).toBe("Hello world");
  });

  it("parses raw JSON requests response", () => {
    const text = '{"type": "requests", "requests": [{"name": "screenshot"}]}';
    const result = parseResponseBlock(text, ["screenshot"]);
    expect(result.requests).toEqual([{ name: "screenshot" }]);
  });

  it("parses raw JSON with code blocks in content", () => {
    const text = '{"type": "message", "content": "Code:\\n\\n```js\\nconst x = 1;\\n```\\n\\nDone."}';
    const result = parseResponseBlock(text, ["screenshot"]);
    expect(result.text).toContain("Code:");
    expect(result.text).toContain("Done.");
  });

  it("parses raw JSON with preamble text before it", () => {
    const text = 'Let me check that.\n{"type": "requests", "requests": [{"name": "screenshot"}]}';
    const result = parseResponseBlock(text, ["screenshot"]);
    expect(result.requests).toEqual([{ name: "screenshot" }]);
    expect(result.text).toBe("Let me check that.");
  });
});

describe("truncateAfterToolCall (backward compat)", () => {
  it("returns text unchanged when no tool names", () => {
    const result = truncateAfterToolCall("Hello", []);
    expect(result.text).toBe("Hello");
    expect(result.toolCall).toBeNull();
  });

  it("returns first request name as toolCall", () => {
    const text = '```response\n{"type": "requests", "requests": [{"name": "page_snapshot"}]}\n```';
    const result = truncateAfterToolCall(text, ["page_snapshot"]);
    expect(result.toolCall).toBe("page_snapshot");
  });

  it("returns null toolCall for message type", () => {
    const text = '```response\n{"type": "message", "content": "Done"}\n```';
    const result = truncateAfterToolCall(text, ["search"]);
    expect(result.toolCall).toBeNull();
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
    expect(prompt).toContain("RESPONSE PROTOCOL");
  });

  it("includes invocation instructions for merged tools", () => {
    const tools: SessionTool[] = [
      { name: "tool_a", description: "First tool" },
      { name: "tool_b", description: "Second tool" },
    ];
    const prompt = buildSystemPrompt("/workspace/test", tools);
    expect(prompt).toContain('"type"');
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

describe("validateResponseBlock", () => {
  it("returns null when no response block present", () => {
    expect(validateResponseBlock("Just some text")).toBeNull();
  });

  it("returns null for valid message block", () => {
    const text = '```response\n{"type": "message", "content": "Hello"}\n```';
    expect(validateResponseBlock(text)).toBeNull();
  });

  it("returns null for valid requests block", () => {
    const text = '```response\n{"type": "requests", "requests": [{"name": "page_snapshot"}]}\n```';
    expect(validateResponseBlock(text)).toBeNull();
  });

  it("returns null for valid requests block with params", () => {
    const text = '```response\n{"type": "requests", "requests": [{"name": "click", "params": {"selector": "#btn"}}]}\n```';
    expect(validateResponseBlock(text)).toBeNull();
  });

  it("returns null for valid multiple requests", () => {
    const text = '```response\n{"type": "requests", "requests": [{"name": "page_snapshot"}, {"name": "console_logs"}]}\n```';
    expect(validateResponseBlock(text)).toBeNull();
  });

  it("returns null for backward-compat single request type", () => {
    const text = '```response\n{"type": "request", "name": "foo"}\n```';
    expect(validateResponseBlock(text)).toBeNull();
  });

  it("returns error for invalid JSON", () => {
    const text = '```response\n{not valid}\n```';
    const err = validateResponseBlock(text);
    expect(err).toContain("Invalid JSON");
  });

  it("returns error for missing type field", () => {
    const text = '```response\n{"name": "foo"}\n```';
    const err = validateResponseBlock(text);
    expect(err).toContain('Missing "type"');
  });

  it("returns error for message without content", () => {
    const text = '```response\n{"type": "message"}\n```';
    const err = validateResponseBlock(text);
    expect(err).toContain('"content" string');
  });

  it("returns error for requests without array", () => {
    const text = '```response\n{"type": "requests", "requests": "not-array"}\n```';
    const err = validateResponseBlock(text);
    expect(err).toContain('"requests" array');
  });

  it("returns error for request item without name", () => {
    const text = '```response\n{"type": "requests", "requests": [{"params": {}}]}\n```';
    const err = validateResponseBlock(text);
    expect(err).toContain('"name" string');
  });

  it("returns error for unknown type", () => {
    const text = '```response\n{"type": "unknown"}\n```';
    const err = validateResponseBlock(text);
    expect(err).toContain('Unknown type');
  });
});
